import type { ApiSessionData } from '../api/types';
import type { DcId, SharedSessionData } from '../types';

import {
  DC_IDS,
  DEBUG, IS_SCREEN_LOCKED_CACHE_KEY,
  SESSION_ACCOUNT_PREFIX,
  SESSION_LEGACY_USER_KEY,
} from '../config';
import { ACCOUNT_SLOT, storeAccountData, writeSlotSession } from './multiaccount';

const BOT_AUTH_FLOOD_WAIT_UNTIL_KEY = 'bot_auth_flood_wait_until';
const FLOOD_WAIT_ERROR_RE = /^FLOOD_WAIT_(\d+)$/;
const SECOND_MS = 1000;

export function hasStoredSession() {
  if (checkSessionLocked()) {
    return true;
  }

  const slotData = loadSlotSession(ACCOUNT_SLOT);
  if (slotData) return Boolean(slotData.dcId);

  if (!ACCOUNT_SLOT) {
    const legacyAuthJson = localStorage.getItem(SESSION_LEGACY_USER_KEY);
    if (legacyAuthJson) {
      try {
        const userAuth = JSON.parse(legacyAuthJson);
        return Boolean(userAuth && userAuth.id && userAuth.dcID);
      } catch (err) {
        // Do nothing.
        return false;
      }
    }
  }

  return false;
}

export function storeSession(sessionData: ApiSessionData) {
  const {
    mainDcId, keys, isTest,
  } = sessionData;
  if (!Object.keys(keys).length) {
    return false;
  }

  const currentSlotData = loadSlotSession(ACCOUNT_SLOT);
  const newSlotData: SharedSessionData = {
    ...currentSlotData,
    dcId: mainDcId,
    isTest,
  };

  Object.keys(keys).map(Number).forEach((dcId) => {
    newSlotData[`dc${dcId as DcId}_auth_key`] = keys[dcId];
  });

  if (!ACCOUNT_SLOT) {
    storeLegacySession(sessionData, currentSlotData?.userId);
  }

  writeSlotSession(ACCOUNT_SLOT, newSlotData);
  return true;
}

function storeLegacySession(sessionData: ApiSessionData, currentUserId?: string) {
  const {
    mainDcId, keys, isTest,
  } = sessionData;

  localStorage.setItem(SESSION_LEGACY_USER_KEY, JSON.stringify({
    dcID: mainDcId,
    id: currentUserId,
    test: isTest,
  }));
  localStorage.setItem('dc', String(mainDcId));
  Object.keys(keys).map(Number).forEach((dcId) => {
    localStorage.setItem(`dc${dcId}_auth_key`, JSON.stringify(keys[dcId]));
  });
}

export function clearStoredSession(slot?: number) {
  if (!slot) {
    clearStoredLegacySession();
  }

  localStorage.removeItem(`${SESSION_ACCOUNT_PREFIX}${slot || 1}`);
}

function clearStoredLegacySession() {
  [
    SESSION_LEGACY_USER_KEY,
    'dc',
    ...DC_IDS.map((dcId) => `dc${dcId}_auth_key`),
    ...DC_IDS.map((dcId) => `dc${dcId}_hash`),
    ...DC_IDS.map((dcId) => `dc${dcId}_server_salt`),
  ].forEach((key) => {
    localStorage.removeItem(key);
  });
}

export function loadStoredSession(): ApiSessionData | undefined {
  if (!hasStoredSession()) {
    return undefined;
  }

  const slotData = loadSlotSession(ACCOUNT_SLOT);

  if (!slotData) {
    if (ACCOUNT_SLOT) return undefined;
    return loadStoredLegacySession();
  }

  const sessionData: ApiSessionData = {
    mainDcId: slotData.dcId,
    keys: DC_IDS.reduce((acc, dcId) => {
      const key = slotData[`dc${dcId}_auth_key` as const];
      if (key) {
        acc[dcId] = key;
      }
      return acc;
    }, {} as Record<number, string>),
    isTest: slotData.isTest || undefined,
  };

  if (!Object.keys(sessionData.keys).length) {
    return undefined;
  }

  return sessionData;
}

export function loadStoredBotSession(): ApiSessionData | undefined {
  const slotData = loadSlotSession(ACCOUNT_SLOT);
  if (!slotData?.isBot || !slotData.botToken) return undefined;

  const sessionData = loadStoredSession();
  if (!sessionData?.keys[sessionData.mainDcId]) return undefined;

  return sessionData;
}

export function loadStoredBotToken() {
  const slotData = loadSlotSession(ACCOUNT_SLOT);
  if (!slotData?.isBot || !slotData.botToken) return undefined;

  return slotData.botToken;
}

export function hasStoredBotSession() {
  return Boolean(loadStoredBotSession());
}

function loadStoredLegacySession(): ApiSessionData | undefined {
  if (!hasStoredSession()) {
    return undefined;
  }

  const userAuth = JSON.parse(localStorage.getItem(SESSION_LEGACY_USER_KEY) || 'null');
  if (!userAuth) {
    return undefined;
  }
  const mainDcId = Number(userAuth.dcID);
  const isTest = userAuth.test;
  const keys: Record<number, string> = {};

  DC_IDS.forEach((dcId) => {
    try {
      const key = localStorage.getItem(`dc${dcId}_auth_key`);
      if (key) {
        keys[dcId] = JSON.parse(key);
      }
    } catch (err) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('Failed to load stored session', err);
      }
      // Do nothing.
    }
  });

  if (!Object.keys(keys).length) return undefined;

  return {
    mainDcId,
    keys,
    isTest,
  };
}

export function loadSlotSession(slot: number | undefined): SharedSessionData | undefined {
  try {
    const data = JSON.parse(localStorage.getItem(`${SESSION_ACCOUNT_PREFIX}${slot || 1}`) || '{}') as SharedSessionData;
    if (!data.dcId) return undefined;
    return data;
  } catch (e) {
    return undefined;
  }
}

export function updateSessionUserId(currentUserId: string) {
  const slotData = loadSlotSession(ACCOUNT_SLOT);
  if (!slotData) return;
  storeAccountData(ACCOUNT_SLOT, { userId: currentUserId });
}

export function storeBotSessionInfo(botToken?: string) {
  const slotData = loadSlotSession(ACCOUNT_SLOT);
  if (!slotData) return false;

  writeSlotSession(ACCOUNT_SLOT, {
    ...slotData,
    isBot: true,
    botToken: botToken || slotData.botToken,
  });

  return true;
}

export function parseFloodWaitSeconds(errorCode?: string) {
  const match = errorCode?.match(FLOOD_WAIT_ERROR_RE);
  if (!match) return undefined;

  return Number(match[1]);
}

export function storeBotAuthFloodWait(seconds: number) {
  const waitUntil = Date.now() + seconds * SECOND_MS;
  localStorage.setItem(BOT_AUTH_FLOOD_WAIT_UNTIL_KEY, String(waitUntil));
}

export function getBotAuthFloodWaitSeconds() {
  const waitUntil = Number(localStorage.getItem(BOT_AUTH_FLOOD_WAIT_UNTIL_KEY));
  if (!waitUntil) return undefined;

  const remainingSeconds = Math.ceil((waitUntil - Date.now()) / SECOND_MS);
  if (remainingSeconds <= 0) {
    clearBotAuthFloodWait();
    return undefined;
  }

  return remainingSeconds;
}

export function clearBotAuthFloodWait() {
  localStorage.removeItem(BOT_AUTH_FLOOD_WAIT_UNTIL_KEY);
}

export function importTestSession() {
  const sessionJson = process.env.TEST_SESSION!;
  try {
    const sessionData = JSON.parse(sessionJson) as ApiSessionData & { userId: string };
    storeLegacySession(sessionData, sessionData.userId);
  } catch (err) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('Failed to load test session', err);
    }
  }
}

export function checkSessionLocked() {
  return localStorage.getItem(IS_SCREEN_LOCKED_CACHE_KEY) === 'true';
}
