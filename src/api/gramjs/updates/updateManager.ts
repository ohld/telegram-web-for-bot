import { Api as GramJs, type Update } from '../../../lib/gramjs';
import { RPCError } from '../../../lib/gramjs/errors';
import { UpdateConnectionState, UpdateServerTimeOffset } from '../../../lib/gramjs/network';
import type { Entity } from '../../../lib/gramjs/types';

import type { ApiChat } from '../../types';
import type { invokeRequest } from '../methods/client';

import { DEBUG } from '../../../config';
import SortedQueue from '../../../util/SortedQueue';
import { buildApiPeerId } from '../apiBuilders/peers';
import { buildInputChannel, buildMtpPeerId } from '../gramjsBuilders';
import localDb from '../localDb';
import { sendApiUpdate } from './apiUpdateEmitter';
import { processAndUpdateEntities } from './entityProcessor';
import { updater } from './mtpUpdateHandler';

import { buildLocalUpdatePts, type UpdatePts } from './UpdatePts';

export type State = {
  seq: number;
  date: number;
  pts: number;
  qts: number;
};
type SeqUpdate = (GramJs.Updates | GramJs.UpdatesCombined) & { _isFromDifference?: true };
type PtsUpdate = ((GramJs.TypeUpdate & { pts: number }) | UpdatePts) & { _isFromDifference?: true };
type EntityUpdate = Update & { _entities?: Entity[] };
type QtsUpdate = Update & { qts: number };
type BotDifferenceScanState = {
  pts: number;
  qts: number;
  date: number;
};
type BotDifferenceScanStats = {
  iterations: number;
  messages: number;
  tooLong: number;
};
type ChannelDifferenceReason = 'gapRecovery' | 'shortpoll';
type ChannelScheduler = {
  timeout?: ReturnType<typeof setTimeout>;
  deadline?: number;
  reason?: ChannelDifferenceReason;
  isInFlight: boolean;
  shortpollTimeoutMs?: number;
  isShortpollEligible?: boolean;
};

const COMMON_BOX_QUEUE_ID = '0';
const INITIAL_CHANNEL_PTS = 1;

const SHORTPOLL_CHANNEL_DIFFERENCE_LIMIT = 100;
const CATCH_UP_CHANNEL_DIFFERENCE_LIMIT = 1000;

const SHORTPOLL_DEFAULT_TIMEOUT_MS = 1000;
const OPENED_CHANNEL_INITIAL_DIFFERENCE_TIMEOUT_MS = 0;
const CHANNEL_DIFFERENCE_ENTITY_RETRY_TIMEOUT_MS = 1000;
const CHANNEL_DIFFERENCE_RETRY_TIMEOUT_MS = 5000;
const CHANNEL_DIFFERENCE_BACKOFF_TIMEOUT_MS = 60000;
const CHANNEL_DIFFERENCE_MAX_PAGES = 4;
const CHANNEL_DIFFERENCE_MAX_RUNTIME_MS = 10000;
const UPDATE_WAIT_TIMEOUT = 500;
const BOT_INITIAL_DIFFERENCE_DATE = 1;
const BOT_INITIAL_DIFFERENCE_PTS = 1;
const BOT_INITIAL_DIFFERENCE_QTS = -1;
const BOT_INITIAL_DIFFERENCE_LIMIT = 1000;
const BOT_INITIAL_DIFFERENCE_MAX_ITERATIONS = 16;
const BOT_INITIAL_DIFFERENCE_MAX_MESSAGES = 1000;
const BOT_INITIAL_DIFFERENCE_MAX_RUNTIME_MS = 15000;
const BOT_INITIAL_DIFFERENCE_MAX_TOO_LONG_RESETS = 1;
const FLOOD_WAIT_ERROR_RE = /^FLOOD_WAIT_(\d+)$/;

const TERMINAL_CHANNEL_DIFFERENCE_ERRORS = new Set([
  'CHANNEL_INVALID',
  'CHANNEL_PRIVATE',
]);

let invoke: typeof invokeRequest;
let isInited = false;

let seqTimeout: ReturnType<typeof setTimeout> | undefined;
const CHANNEL_SCHEDULERS = new Map<string, ChannelScheduler>();
const OPENED_CHANNEL_IDS = new Set<string>();

const SEQ_QUEUE = new SortedQueue<SeqUpdate>(seqComparator);
const PTS_QUEUE = new Map<string, SortedQueue<PtsUpdate>>();

export async function init(invokeReq: typeof invokeRequest, shouldScanInitialBotDifference = false) {
  invoke = invokeReq;

  await loadRemoteState();
  isInited = true;

  if (shouldScanInitialBotDifference) {
    await scanInitialBotDifference();
  }

  scheduleGetDifference();
}

export function applyState(state: State) {
  localDb.commonBoxState.seq = state.seq;
  localDb.commonBoxState.date = state.date;
  localDb.commonBoxState.pts = state.pts;
  localDb.commonBoxState.qts = state.qts;
}

export function processUpdate(update: Update, isFromDifference?: boolean, shouldOnlySave?: boolean) {
  if (update instanceof UpdateConnectionState) {
    if (update.state === UpdateConnectionState.connected && isInited) {
      scheduleGetDifference();
    }

    updater(update);
    return;
  }

  if (update instanceof UpdateServerTimeOffset) {
    updater(update);
    return;
  }

  if (localDb.commonBoxState.seq === undefined) {
    // Drop updates received before first sync
    return;
  }

  if (update instanceof GramJs.Updates || update instanceof GramJs.UpdatesCombined) {
    if (isFromDifference) {
      (update as SeqUpdate)._isFromDifference = true;
    }

    saveSeqUpdate(update, shouldOnlySave);
    return;
  }

  if ('pts' in update) {
    if (update instanceof GramJs.UpdateChannelTooLong) {
      scheduleChannelDifference(getUpdateChannelId(update), 'gapRecovery', 0);
      return;
    }
    if (isFromDifference) {
      (update as PtsUpdate)._isFromDifference = true;
    }
    savePtsUpdate(update, shouldOnlySave);
    return;
  }

  updateQts(update);
  updater(update);
}

export function updateChannelState(channelId: string, pts: number) {
  const channel = localDb.chats[channelId];
  if (!(channel instanceof GramJs.Channel)) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error(`[UpdateManager] Channel ${channelId} not found in localDb`);
    }
    return;
  }

  const currentState = localDb.channelPtsById[channelId];

  if (currentState && currentState < pts) {
    scheduleGetChannelDifference(channelId);
    return;
  }

  localDb.channelPtsById[channelId] = pts;
}

function applyUpdate(updateObject: SeqUpdate | PtsUpdate) {
  if ('seq' in updateObject && updateObject.seq) {
    localDb.commonBoxState.seq = updateObject.seq;
    localDb.commonBoxState.date = updateObject.date;
  }

  if ('qts' in updateObject) {
    localDb.commonBoxState.qts = updateObject.qts;
  }

  if ('pts' in updateObject) {
    const channelId = getUpdateChannelId(updateObject);
    if (channelId !== COMMON_BOX_QUEUE_ID) {
      localDb.channelPtsById[channelId] = updateObject.pts;
    } else {
      localDb.commonBoxState.pts = updateObject.pts;
    }
  }

  if (updateObject instanceof GramJs.UpdatesCombined || updateObject instanceof GramJs.Updates) {
    processAndUpdateEntities(updateObject);
    const entities = (updateObject.users as Entity[]).concat(updateObject.chats);

    updateObject.updates.forEach((update) => {
      if (entities) {
        (update as any)._entities = entities;
      }

      processUpdate(update);
    });
  } else {
    updater(updateObject);
  }
}

function saveSeqUpdate(update: GramJs.Updates | GramJs.UpdatesCombined, shouldOnlySave?: boolean) {
  SEQ_QUEUE.add(update);

  if (!shouldOnlySave) popSeqQueue();
}

function savePtsUpdate(update: PtsUpdate, shouldOnlySave?: boolean) {
  const channelId = getUpdateChannelId(update);

  const ptsQueue = PTS_QUEUE.get(channelId) || new SortedQueue<PtsUpdate>(ptsComparator);
  ptsQueue.add(update);

  PTS_QUEUE.set(channelId, ptsQueue);

  if (!shouldOnlySave) popPtsQueue(channelId);
}

function popSeqQueue() {
  if (!SEQ_QUEUE.size) return;

  const update = SEQ_QUEUE.pop()!;
  const localSeq = localDb.commonBoxState.seq;
  const seqStart = 'seqStart' in update ? update.seqStart : update.seq;

  if (seqStart === 0 || (update._isFromDifference && seqStart >= localSeq + 1)) {
    applyUpdate(update);
  } else if (seqStart === localSeq + 1) {
    clearTimeout(seqTimeout);
    seqTimeout = undefined;

    applyUpdate(update);
  } else if (seqStart > localSeq + 1) {
    SEQ_QUEUE.add(update); // Return update to queue
    scheduleGetDifference();
    return; // Prevent endless loop
  }

  popSeqQueue();
}

function popPtsQueue(channelId: string) {
  const ptsQueue = PTS_QUEUE.get(channelId);
  if (!ptsQueue?.size) return;

  const update = ptsQueue.pop()!;
  const localPts = channelId === COMMON_BOX_QUEUE_ID ? localDb.commonBoxState.pts : localDb.channelPtsById[channelId];
  const pts = update.pts;
  const ptsCount = getPtsCount(update);

  // Bot updates can discover a channel message before local channel state is initialized
  if (localPts === undefined) {
    if (canSeedChannelPtsFromUpdate(channelId, update)) {
      applyUpdate(update);
      popPtsQueue(channelId);
      return;
    }

    return;
  }

  if (update._isFromDifference && pts >= localPts + ptsCount) {
    applyUpdate(update);
  } else if (pts === localPts + ptsCount) {
    clearScheduledChannelDifference(channelId, 'gapRecovery');
    scheduleShortpollFromNow(channelId);

    applyUpdate(update);
  } else if (pts > localPts + ptsCount) {
    ptsQueue.add(update); // Return update to queue
    if (channelId === COMMON_BOX_QUEUE_ID) {
      scheduleGetDifference();
    } else {
      scheduleGetChannelDifference(channelId);
    }
    return; // Prevent endless loop
  }

  popPtsQueue(channelId);
}

export function scheduleGetChannelDifference(channelId: string) {
  scheduleChannelDifference(channelId, 'gapRecovery', UPDATE_WAIT_TIMEOUT);
}

export function requestChannelDifference(channelId: string) {
  scheduleChannelDifference(channelId, 'gapRecovery', 0);
}

export function setOpenedChannelIds(channelIds: string[]) {
  const nextOpenedChannelIds = new Set(channelIds);

  OPENED_CHANNEL_IDS.forEach((channelId) => {
    if (nextOpenedChannelIds.has(channelId)) {
      return;
    }

    getOrCreateChannelScheduler(channelId).isShortpollEligible = false;
    clearScheduledChannelDifference(channelId, 'shortpoll');
  });

  channelIds.forEach((channelId) => {
    const scheduler = getOrCreateChannelScheduler(channelId);
    const wasOpened = OPENED_CHANNEL_IDS.has(channelId);

    scheduler.isShortpollEligible = true;

    if (!wasOpened) {
      if (scheduler.shortpollTimeoutMs !== undefined) {
        restartShortpollFromNow(channelId);
      } else {
        scheduleChannelDifference(channelId, 'shortpoll', OPENED_CHANNEL_INITIAL_DIFFERENCE_TIMEOUT_MS);
      }
    }
  });

  OPENED_CHANNEL_IDS.clear();
  channelIds.forEach((channelId) => {
    OPENED_CHANNEL_IDS.add(channelId);
  });
}

function getOrCreateChannelScheduler(channelId: string) {
  const current = CHANNEL_SCHEDULERS.get(channelId);
  if (current) {
    return current;
  }

  const scheduler: ChannelScheduler = {
    isInFlight: false,
  };
  CHANNEL_SCHEDULERS.set(channelId, scheduler);
  return scheduler;
}

function scheduleChannelDifference(channelId: string, reason: ChannelDifferenceReason, timeoutMs: number) {
  const scheduler = getOrCreateChannelScheduler(channelId);
  const deadline = Date.now() + timeoutMs;
  if (scheduler.deadline !== undefined && scheduler.deadline <= deadline) {
    return;
  }

  clearScheduledChannelDifference(channelId);

  scheduler.reason = reason;
  scheduler.deadline = deadline;
  scheduler.timeout = setTimeout(() => {
    scheduler.timeout = undefined;
    scheduler.deadline = undefined;
    if (scheduler.isInFlight) {
      scheduleChannelDifference(channelId, reason, UPDATE_WAIT_TIMEOUT);
      return;
    }

    void runChannelDifference(channelId, reason);
  }, timeoutMs);
}

function clearScheduledChannelDifference(channelId: string, reason?: ChannelDifferenceReason) {
  const scheduler = CHANNEL_SCHEDULERS.get(channelId);
  if (!scheduler?.timeout || (reason && scheduler.reason !== reason)) {
    return;
  }

  clearTimeout(scheduler.timeout);
  scheduler.timeout = undefined;
  scheduler.deadline = undefined;
  scheduler.reason = undefined;
}

function scheduleShortpollFromNow(channelId: string) {
  const scheduler = CHANNEL_SCHEDULERS.get(channelId);
  if (!scheduler?.isShortpollEligible || scheduler.shortpollTimeoutMs === undefined) {
    return;
  }

  scheduleChannelDifference(channelId, 'shortpoll', scheduler.shortpollTimeoutMs);
}

function restartShortpollFromNow(channelId: string) {
  const scheduler = CHANNEL_SCHEDULERS.get(channelId);
  if (!scheduler?.isShortpollEligible || scheduler.shortpollTimeoutMs === undefined || scheduler.isInFlight) {
    return;
  }

  if (scheduler.reason === 'shortpoll') {
    clearScheduledChannelDifference(channelId);
  }

  scheduleChannelDifference(channelId, 'shortpoll', scheduler.shortpollTimeoutMs);
}

function scheduleGetDifference() {
  if (seqTimeout) return;

  seqTimeout = setTimeout(() => {
    void getDifference().catch((err: unknown) => {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('[UpdatesManager] Failed to get Difference', err);
      }
    }).finally(() => {
      seqTimeout = undefined;
    });
  }, UPDATE_WAIT_TIMEOUT);
}

function getUpdateChannelId(update: Update) {
  if ('channelId' in update && 'pts' in update) {
    return buildApiPeerId(update.channelId, 'channel');
  }

  if (update instanceof GramJs.UpdateNewChannelMessage || update instanceof GramJs.UpdateEditChannelMessage) {
    const peer = update.message.peerId as GramJs.PeerChannel;
    return buildApiPeerId(peer.channelId, 'channel');
  }

  return COMMON_BOX_QUEUE_ID;
}

export async function getDifference() {
  if (!isInited) {
    return;
  }

  if (!localDb.commonBoxState?.date) {
    forceSync();
    return;
  }

  sendApiUpdate({
    '@type': 'updateFetchingDifference',
    isFetching: true,
  });

  try {
    while (true) {
      const response = await invoke(new GramJs.updates.GetDifference({
        pts: localDb.commonBoxState.pts,
        date: localDb.commonBoxState.date,
        qts: localDb.commonBoxState.qts,
      }));

      if (!response || response instanceof GramJs.updates.DifferenceTooLong) {
        forceSync();
        return;
      }

      if (response instanceof GramJs.updates.DifferenceEmpty) {
        localDb.commonBoxState.seq = response.seq;
        localDb.commonBoxState.date = response.date;
        return;
      }

      processDifference(response);

      const newState = response instanceof GramJs.updates.DifferenceSlice ? response.intermediateState : response.state;
      applyState(newState);

      if (!(response instanceof GramJs.updates.DifferenceSlice)) {
        return;
      }
    }
  } finally {
    sendApiUpdate({
      '@type': 'updateFetchingDifference',
      isFetching: false,
    });
  }
}

async function runChannelDifference(channelId: string, reason: ChannelDifferenceReason) {
  const scheduler = getOrCreateChannelScheduler(channelId);
  if (scheduler.isInFlight) {
    return;
  }

  scheduler.isInFlight = true;
  scheduler.reason = reason;

  try {
    await requestChannelDifferenceInternal(channelId, reason, 0, Date.now() + CHANNEL_DIFFERENCE_MAX_RUNTIME_MS);
  } finally {
    scheduler.isInFlight = false;
  }
}

async function requestChannelDifferenceInternal(
  channelId: string, reason: ChannelDifferenceReason, pageCount: number, deadline: number,
): Promise<void> {
  const channel = localDb.chats[channelId];
  if (!channel) {
    const scheduler = getOrCreateChannelScheduler(channelId);
    if (scheduler.isShortpollEligible) {
      scheduleChannelDifference(channelId, reason, CHANNEL_DIFFERENCE_ENTITY_RETRY_TIMEOUT_MS);
    }
    return;
  }

  if (!(channel instanceof GramJs.Channel) || !channel.accessHash) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error('[UpdateManager] Channel for difference not found', channelId, channel);
    }
    return;
  }

  const limit = reason === 'shortpoll' ? SHORTPOLL_CHANNEL_DIFFERENCE_LIMIT : CATCH_UP_CHANNEL_DIFFERENCE_LIMIT;
  const localPts = getChannelDifferencePts(channelId);
  let response: GramJs.updates.TypeChannelDifference;

  try {
    const result = await invoke(new GramJs.updates.GetChannelDifference({
      channel: buildInputChannel(channelId, channel.accessHash.toString()),
      pts: localPts,
      filter: new GramJs.ChannelMessagesFilterEmpty(),
      limit,
    }), {
      shouldThrow: true,
    });
    if (!result) {
      return;
    }

    response = result;
  } catch (err) {
    handleChannelDifferenceError(channelId, reason, err);
    return;
  }

  if (response instanceof GramJs.updates.ChannelDifferenceTooLong) {
    handleChannelDifferenceTooLong(channelId, reason, response);
    return;
  }

  localDb.channelPtsById[channelId] = response.pts;
  updateChannelShortpollTimeout(channelId, response);

  if (response instanceof GramJs.updates.ChannelDifferenceEmpty) {
    if (response.final) {
      scheduleShortpollIfEligible(channelId);
    }

    popPtsQueue(channelId); // Continue processing updates in queue
    return;
  }

  processDifference(response, channelId);

  if (!response.final) {
    if (pageCount + 1 >= CHANNEL_DIFFERENCE_MAX_PAGES || Date.now() >= deadline) {
      scheduleChannelDifference(channelId, 'gapRecovery', CHANNEL_DIFFERENCE_BACKOFF_TIMEOUT_MS);
      return;
    }

    await requestChannelDifferenceInternal(channelId, 'gapRecovery', pageCount + 1, deadline);
    return;
  }

  scheduleShortpollIfEligible(channelId);
}

function updateChannelShortpollTimeout(channelId: string, response: GramJs.updates.TypeChannelDifference) {
  const scheduler = getOrCreateChannelScheduler(channelId);
  scheduler.shortpollTimeoutMs = ('timeout' in response && response.timeout)
    ? response.timeout * 1000
    : SHORTPOLL_DEFAULT_TIMEOUT_MS;
}

function scheduleShortpollIfEligible(channelId: string) {
  const scheduler = getOrCreateChannelScheduler(channelId);
  if (!scheduler.isShortpollEligible) {
    return;
  }

  scheduleShortpollFromNow(channelId);
}

function handleChannelDifferenceError(channelId: string, reason: ChannelDifferenceReason, err: unknown) {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.warn('[UpdatesManager] Failed to get ChannelDifference', channelId, err);
  }

  const scheduler = getOrCreateChannelScheduler(channelId);
  const errorMessage = err instanceof RPCError ? err.errorMessage : undefined;

  if (errorMessage && TERMINAL_CHANNEL_DIFFERENCE_ERRORS.has(errorMessage)) {
    scheduler.isShortpollEligible = false;
    clearScheduledChannelDifference(channelId);
    return;
  }

  const floodWaitSeconds = parseFloodWaitSeconds(errorMessage);
  const retryTimeoutMs = floodWaitSeconds
    ? floodWaitSeconds * 1000
    : CHANNEL_DIFFERENCE_RETRY_TIMEOUT_MS;

  scheduleChannelDifference(channelId, reason, retryTimeoutMs);
}

function forceSync() {
  reset();

  sendApiUpdate({
    '@type': 'requestSync',
  });

  void loadRemoteState().catch((err: unknown) => {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[UpdatesManager] Failed to reload remote state', err);
    }
  });
}

export function reset() {
  PTS_QUEUE.clear();
  SEQ_QUEUE.clear();

  clearTimeout(seqTimeout);
  seqTimeout = undefined;

  CHANNEL_SCHEDULERS.forEach(({ timeout }) => {
    if (!timeout) {
      return;
    }

    clearTimeout(timeout);
  });
  CHANNEL_SCHEDULERS.clear();
  OPENED_CHANNEL_IDS.clear();

  localDb.commonBoxState = {};

  Object.keys(localDb.channelPtsById).forEach((channelId) => {
    localDb.channelPtsById[channelId] = 0;
  });

  isInited = false;
}

export function processAffectedHistory(
  chat: ApiChat, affected: GramJs.messages.AffectedMessages | GramJs.messages.AffectedHistory,
) {
  const isChannel = chat.type === 'chatTypeChannel' || chat.type === 'chatTypeSuperGroup';
  const channeId = isChannel ? buildMtpPeerId(chat.id, 'channel') : undefined;
  const update = buildLocalUpdatePts(affected.pts, affected.ptsCount, channeId);

  processUpdate(update);
}

async function loadRemoteState() {
  const remoteState = await invoke(new GramJs.updates.GetState());
  if (!remoteState) return;

  applyState(remoteState);

  isInited = true;
}

function processDifference(
  difference: GramJs.updates.Difference | GramJs.updates.DifferenceSlice | GramJs.updates.ChannelDifference,
  channelId?: string,
) {
  processDifferenceMessages(difference);
  const entities = getDifferenceEntities(difference);

  // Ignore `pts`/`seq` holes when applying updates from difference
  // BUT, if we got an `UpdateChannelTooLong`, make sure to process other updates after receiving `ChannelDifference`
  const channelTooLongIds = new Set<string>();

  difference.otherUpdates.forEach((update) => {
    (update as EntityUpdate)._entities = entities;

    const updateChannelId = getUpdateChannelId(update);

    if (update instanceof GramJs.UpdateChannelTooLong) {
      channelTooLongIds.add(getUpdateChannelId(update));
    }

    const shouldApplyImmediately = !channelTooLongIds.has(updateChannelId);
    processUpdate(update, shouldApplyImmediately, !shouldApplyImmediately);
  });

  // Continue processing updates in queues
  if (channelId) {
    popPtsQueue(channelId);
  } else {
    popSeqQueue();
  }
}

function processDifferenceMessages(
  difference: GramJs.updates.Difference | GramJs.updates.DifferenceSlice | GramJs.updates.ChannelDifference,
) {
  processAndUpdateEntities(difference);
  const entities = getDifferenceEntities(difference);

  difference.newMessages.forEach((message) => {
    if (message instanceof GramJs.MessageEmpty) {
      return;
    }

    const update: EntityUpdate = message.peerId instanceof GramJs.PeerChannel
      ? new GramJs.UpdateNewChannelMessage({
        message,
        pts: 0,
        ptsCount: 0,
      })
      : new GramJs.UpdateNewMessage({
        message,
        pts: 0,
        ptsCount: 0,
      });

    update._entities = entities;
    updater(update);
  });
}

function handleChannelDifferenceTooLong(
  channelId: string, reason: ChannelDifferenceReason, difference: GramJs.updates.ChannelDifferenceTooLong,
) {
  processAndUpdateEntities(difference);
  const entities = (difference.users as Entity[]).concat(difference.chats);

  difference.messages.forEach((message) => {
    if (message instanceof GramJs.MessageEmpty) {
      return;
    }

    const update: EntityUpdate = new GramJs.UpdateNewChannelMessage({
      message,
      pts: 0,
      ptsCount: 0,
    });

    update._entities = entities;
    updater(update);
  });

  if (difference.dialog instanceof GramJs.Dialog && difference.dialog.pts !== undefined) {
    localDb.channelPtsById[channelId] = difference.dialog.pts;
  }

  updateChannelShortpollTimeout(channelId, difference);
  popPtsQueue(channelId);

  if (difference.final) {
    scheduleShortpollIfEligible(channelId);
    return;
  }

  const scheduler = getOrCreateChannelScheduler(channelId);
  const retryTimeoutMs = scheduler.isShortpollEligible
    ? (scheduler.shortpollTimeoutMs ?? SHORTPOLL_DEFAULT_TIMEOUT_MS)
    : CHANNEL_DIFFERENCE_BACKOFF_TIMEOUT_MS;

  scheduleChannelDifference(channelId, reason, retryTimeoutMs);
}

async function scanInitialBotDifference() {
  const deadline = Date.now() + BOT_INITIAL_DIFFERENCE_MAX_RUNTIME_MS;
  const stats: BotDifferenceScanStats = {
    iterations: 0,
    messages: 0,
    tooLong: 0,
  };
  let state: BotDifferenceScanState = {
    pts: BOT_INITIAL_DIFFERENCE_PTS,
    date: BOT_INITIAL_DIFFERENCE_DATE,
    qts: BOT_INITIAL_DIFFERENCE_QTS,
  };

  while (shouldContinueBotDifferenceScan(stats, deadline)) {
    stats.iterations++;

    const response = await requestBotDifference(state).catch((err: unknown) => {
      if (isFloodWaitRpcError(err)) {
        return undefined;
      }

      throw err;
    });

    if (!response) {
      break;
    }

    if (response instanceof GramJs.updates.DifferenceTooLong) {
      stats.tooLong++;

      if (stats.tooLong > BOT_INITIAL_DIFFERENCE_MAX_TOO_LONG_RESETS) {
        break;
      }

      state = {
        pts: response.pts,
        date: localDb.commonBoxState.date ?? BOT_INITIAL_DIFFERENCE_DATE,
        qts: localDb.commonBoxState.qts ?? BOT_INITIAL_DIFFERENCE_QTS,
      };
      continue;
    }

    if (response instanceof GramJs.updates.DifferenceEmpty) {
      break;
    }

    stats.messages += response.newMessages.length;
    processDifference(response);

    const nextState = response instanceof GramJs.updates.DifferenceSlice
      ? response.intermediateState
      : response.state;

    state = {
      pts: nextState.pts,
      date: nextState.date,
      qts: nextState.qts,
    };

    if (!(response instanceof GramJs.updates.DifferenceSlice)) {
      break;
    }
  }
}

function shouldContinueBotDifferenceScan(stats: BotDifferenceScanStats, deadline: number) {
  return Date.now() < deadline
    && stats.iterations < BOT_INITIAL_DIFFERENCE_MAX_ITERATIONS
    && stats.messages < BOT_INITIAL_DIFFERENCE_MAX_MESSAGES;
}

function requestBotDifference(state: BotDifferenceScanState) {
  return invoke(new GramJs.updates.GetDifference({
    pts: state.pts,
    date: state.date,
    qts: state.qts,
    ptsTotalLimit: BOT_INITIAL_DIFFERENCE_LIMIT,
  }));
}

function getDifferenceEntities(
  difference: GramJs.updates.Difference | GramJs.updates.DifferenceSlice | GramJs.updates.ChannelDifference,
) {
  return (difference.users as Entity[]).concat(difference.chats);
}

function getPtsCount(update: PtsUpdate) {
  return 'ptsCount' in update ? update.ptsCount : 0;
}

function getChannelDifferencePts(channelId: string) {
  const pts = localDb.channelPtsById[channelId];
  return typeof pts === 'number' && pts > 0 ? pts : INITIAL_CHANNEL_PTS;
}

function updateQts(update: Update) {
  if (!('qts' in update)) {
    return;
  }

  const { qts } = update as QtsUpdate;
  if (qts > (localDb.commonBoxState.qts ?? 0)) {
    localDb.commonBoxState.qts = qts;
  }
}

function canSeedChannelPtsFromUpdate(channelId: string, update: PtsUpdate) {
  if (channelId === COMMON_BOX_QUEUE_ID) {
    return false;
  }

  if (update._isFromDifference || localDb.chats[channelId]) {
    return true;
  }

  return Boolean((update as EntityUpdate)._entities?.some((entity) => {
    return (
      (entity instanceof GramJs.Channel || entity instanceof GramJs.ChannelForbidden)
      && buildApiPeerId(entity.id, 'channel') === channelId
    );
  }));
}

function parseFloodWaitSeconds(errorMessage?: string) {
  const match = errorMessage?.match(FLOOD_WAIT_ERROR_RE);
  if (!match) return undefined;

  return Number(match[1]);
}

function isFloodWaitRpcError(err: unknown): err is RPCError {
  return err instanceof RPCError && parseFloodWaitSeconds(err.errorMessage) !== undefined;
}

function seqComparator(a: SeqUpdate, b: SeqUpdate) {
  const seqA = 'seqStart' in a ? a.seqStart : a.seq;
  const seqB = 'seqStart' in b ? b.seqStart : b.seq;

  return seqA - seqB;
}

function ptsComparator(a: PtsUpdate, b: PtsUpdate) {
  const diff = a.pts - b.pts;
  if (diff !== 0) {
    return diff;
  }

  return getPtsCount(b) - getPtsCount(a);
}
