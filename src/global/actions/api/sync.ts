import { addCallback } from '../../../lib/teact/teactn';

import type { ThreadId, ThreadLocalState } from '../../../types';
import type { RequiredGlobalActions } from '../../index';
import type { ActionReturnType, GlobalState } from '../../types';
import { type ApiChat, MAIN_THREAD_ID } from '../../../api/types';

import { DEBUG, MESSAGE_LIST_SLICE, SERVICE_NOTIFICATIONS_USER_ID } from '../../../config';
import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { init as initFolderManager } from '../../../util/folderManager';
import {
  buildCollectionByKey, omitUndefined, pick, unique,
} from '../../../util/iteratees';
import { hasStoredBotSession } from '../../../util/sessions';
import { callApi } from '../../../api/gramjs';
import { getIsSavedDialog, getUserFullName } from '../../helpers';
import {
  addActionHandler, getActions, getGlobal, setGlobal,
} from '../../index';
import {
  addChatMessagesById,
  safeReplaceViewportIds,
  updateChats,
  updateListedIds,
  updateUsers,
} from '../../reducers';
import { updateTabState } from '../../reducers/tabs';
import {
  replaceThreadLocalStateParam,
  updateThreadInfo,
  updateThreadLocalState,
  updateThreadReadState,
} from '../../reducers/threads';
import {
  selectChat,
  selectChatMessage,
  selectChatMessages,
  selectCurrentMessageList,
  selectTabState,
  selectTopics,
  selectUser,
  selectViewportIds,
} from '../../selectors';
import {
  selectDraft,
  selectEditingDraft,
  selectEditingId,
  selectThreadInfo,
  selectThreadReadState,
} from '../../selectors/threads';

const RELEASE_STATUS_TIMEOUT = 15000; // 15 sec;

let releaseStatusTimeout: number | undefined;

addActionHandler('sync', (global, actions): ActionReturnType => {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('>>> START SYNC');
  }

  if (releaseStatusTimeout) {
    clearTimeout(releaseStatusTimeout);
  }

  global = getGlobal();
  global = { ...global, isSyncing: true };
  setGlobal(global);

  if (selectIsCurrentBot(global)) {
    finishBotSync(global);
    return;
  }

  // Workaround for `isSyncing = true` sometimes getting stuck for some reason
  releaseStatusTimeout = window.setTimeout(() => {
    global = getGlobal();
    global = { ...global, isSyncing: false };
    setGlobal(global);
    releaseStatusTimeout = undefined;
  }, RELEASE_STATUS_TIMEOUT);

  const {
    loadAllChats, preloadTopChatMessages,
  } = actions;

  initFolderManager();

  loadAllChats({
    listType: 'active',
    whenFirstBatchDone: async () => {
      await loadAndReplaceMessages(global, actions);

      global = getGlobal();
      global = {
        ...global,
        isSyncing: false,
        isSynced: true,
        isFetchingDifference: false,
      };
      setGlobal(global);

      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.log('>>> FINISH SYNC');
      }

      loadAllChats({ listType: 'archived' });
      preloadTopChatMessages();
    },
  });
});

function selectIsCurrentBot<T extends GlobalState>(global: T) {
  const { currentUserId } = global;
  return Boolean(
    (currentUserId && selectUser(global, currentUserId)?.type === 'userTypeBot')
    || hasStoredBotSession(),
  );
}

function finishBotSync<T extends GlobalState>(global: T) {
  if (releaseStatusTimeout) {
    clearTimeout(releaseStatusTimeout);
    releaseStatusTimeout = undefined;
  }

  global = getGlobal();
  global = finishBotChatList(global);
  global = {
    ...global,
    isSyncing: false,
    isSynced: true,
    isFetchingDifference: false,
  };
  setGlobal(global);

  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('>>> FINISH BOT SYNC');
  }
}

function finishBotChatList<T extends GlobalState>(global: T) {
  const activeIds = unique([
    ...(global.chats.listIds.active || []),
    ...selectBotActiveChatIds(global),
  ]);
  const privateChats = buildBotPrivateChats(global, activeIds);
  const lastMessageByChatId = buildBotLastMessageIds(global, activeIds);

  return {
    ...global,
    chats: {
      ...global.chats,
      byId: {
        ...global.chats.byId,
        ...privateChats,
      },
      listIds: {
        ...global.chats.listIds,
        active: activeIds,
        archived: global.chats.listIds.archived || [],
        saved: global.chats.listIds.saved || [],
      },
      isFullyLoaded: {
        ...global.chats.isFullyLoaded,
        active: true,
        archived: true,
        saved: true,
      },
      loadingParameters: {
        ...global.chats.loadingParameters,
        active: {},
        archived: {},
        saved: {},
      },
      totalCount: {
        ...global.chats.totalCount,
        all: activeIds.length,
        archived: global.chats.totalCount.archived || 0,
        saved: global.chats.totalCount.saved || 0,
      },
      lastMessageIds: {
        ...global.chats.lastMessageIds,
        all: {
          ...global.chats.lastMessageIds.all,
          ...lastMessageByChatId,
        },
      },
    },
  };
}

function buildBotPrivateChats<T extends GlobalState>(global: T, chatIds: string[]) {
  return chatIds.reduce<Record<string, ApiChat>>((privateChats, chatId) => {
    if (selectChat(global, chatId)) {
      return privateChats;
    }

    const user = selectUser(global, chatId);
    const title = getUserFullName(user);
    if (!user || !title) {
      return privateChats;
    }

    privateChats[chatId] = omitUndefined({
      id: user.id,
      type: 'chatTypePrivate',
      title,
      isMin: user.isMin,
      accessHash: user.accessHash,
      isVerified: user.isVerified,
      usernames: user.usernames,
      hasUsername: user.hasUsername,
      hasVideoAvatar: user.hasVideoAvatar,
      avatarPhotoId: user.avatarPhotoId,
      isSupport: user.isSupport,
      fakeType: user.fakeType,
      color: user.color,
      profileColor: user.profileColor,
      emojiStatus: user.emojiStatus,
      isForum: user.isBotForum,
      isBotForum: user.isBotForum,
      botVerificationIconId: user.botVerificationIconId,
      paidMessagesStars: user.paidMessagesStars,
    });

    return privateChats;
  }, {});
}

function buildBotLastMessageIds<T extends GlobalState>(global: T, chatIds: string[]) {
  return chatIds.reduce<Record<string, number>>((lastMessageByChatId, chatId) => {
    const messageId = selectLatestMessageId(global, chatId);
    if (messageId) {
      lastMessageByChatId[chatId] = messageId;
    }

    return lastMessageByChatId;
  }, {});
}

function selectBotActiveChatIds<T extends GlobalState>(global: T) {
  return Object.keys(global.messages.byChatId)
    .filter((chatId) => {
      const chat = selectChat(global, chatId);
      const user = selectUser(global, chatId);
      const messages = selectChatMessages(global, chatId);

      return Boolean((chat || user) && messages && Object.keys(messages).length);
    })
    .sort((firstChatId, secondChatId) => {
      return selectLatestMessageDate(global, secondChatId) - selectLatestMessageDate(global, firstChatId);
    });
}

function selectLatestMessageId<T extends GlobalState>(global: T, chatId: string) {
  const messages = selectChatMessages(global, chatId);
  if (!messages) return undefined;

  return Object.values(messages).reduce((latestMessageId, message) => {
    return message.date > (messages[latestMessageId]?.date || 0) ? message.id : latestMessageId;
  }, 0);
}

function selectLatestMessageDate<T extends GlobalState>(global: T, chatId: string) {
  const messages = selectChatMessages(global, chatId);
  if (!messages) return 0;

  return Object.values(messages).reduce((latestDate, message) => {
    return Math.max(latestDate, message.date);
  }, 0);
}

async function loadAndReplaceMessages<T extends GlobalState>(global: T, actions: RequiredGlobalActions) {
  let areMessagesLoaded = false;

  global = getGlobal();

  let wasReset = false;
  const preservedTabThreadsByTabId = preserveCurrentTabThreads(global);
  const preservedCurrentThreadsByChatId = preserveCurrentThreads(global);

  // Memoize drafts
  const draftChatIds = Object.keys(global.messages.byChatId);
  const draftsByChatId = draftChatIds
    .reduce<Record<string, Record<number, Partial<ThreadLocalState>>>>((acc, chatId) => {
      acc[chatId] = Object
        .keys(global.messages.byChatId[chatId].threadsById)
        .reduce<Record<number, Partial<ThreadLocalState>>>((acc2, threadId) => {
          acc2[Number(threadId)] = omitUndefined({
            draft: selectDraft(global, chatId, Number(threadId)),
            editingId: selectEditingId(global, chatId, Number(threadId)),
            editingDraft: selectEditingDraft(global, chatId, Number(threadId)),
          });

          return acc2;
        }, {});
      return acc;
    }, {});

  const currentTabId = getCurrentTabId();
  const tabs = Object.values(global.byTabId)
    .sort(({ id: leftId }, { id: rightId }) => {
      if (leftId === currentTabId) return -1;
      if (rightId === currentTabId) return 1;
      return 0;
    });

  for (const { id: tabId } of tabs) {
    global = getGlobal();
    const { chatId: currentChatId, threadId: currentThreadId } = selectCurrentMessageList(global, tabId) || {};
    const activeThreadId = currentThreadId || MAIN_THREAD_ID;
    const currentChat = currentChatId ? global.chats.byId[currentChatId] : undefined;
    const currentViewportIds = currentChatId
      ? selectViewportIds(global, currentChatId, activeThreadId, tabId)
      : undefined;
    const isSavedDialog = currentChatId
      ? getIsSavedDialog(currentChatId, activeThreadId, global.currentUserId)
      : false;
    if (currentChatId && currentChat) {
      const discussionChat = resolveDiscussionChat(global, currentChatId, activeThreadId);
      const [result, resultDiscussion, refreshedViewportMessages] = await Promise.all([
        loadTopMessages(
          global,
          currentChatId,
          activeThreadId,
          currentViewportIds,
        ),
        discussionChat
          ? callApi('fetchDiscussionMessage', {
            chat: discussionChat.chat,
            messageId: discussionChat.messageId,
          }) : undefined,
        currentViewportIds?.length && !isSavedDialog
          ? callApi('fetchMessagesById', {
            chat: currentChat,
            messageIds: currentViewportIds,
          }).catch(() => undefined)
          : undefined,
      ]);
      global = getGlobal();
      const { chatId: newCurrentChatId } = selectCurrentMessageList(global, tabId) || {};

      if (result && newCurrentChatId === currentChatId) {
        const currentChatMessages = selectChatMessages(global, currentChatId);
        const localMessages = currentChatId === SERVICE_NOTIFICATIONS_USER_ID
          ? global.serviceNotifications.filter(({ isDeleted }) => !isDeleted).map(({ message }) => message)
          : [];
        const topics = selectTopics(global, currentChatId);
        const topicLastMessages = topics ? Object.values(topics)
          .map(({ id }) => {
            const topicThreadInfo = selectThreadInfo(global, currentChatId, id);
            return topicThreadInfo?.lastMessageId ? currentChatMessages[topicThreadInfo.lastMessageId] : undefined;
          }).filter(Boolean) : [];

        const resultMessageIds = result.messages.map(({ id }) => id);
        const messagesThreads = pick(global.messages.byChatId[currentChatId].threadsById, resultMessageIds);

        const isDiscussionStartLoaded = !result.messages.length
          || result.messages.some(({ id }) => id === resultDiscussion?.firstMessageId);
        const threadStartMessages = (isDiscussionStartLoaded && resultDiscussion?.topMessages) || [];
        const refreshedViewportIds = refreshedViewportMessages?.map(({ id }) => id) || [];
        const allMessages = threadStartMessages.concat(result.messages, refreshedViewportMessages || [], localMessages);
        const allMessagesWithTopicLastMessages = allMessages.concat(topicLastMessages);
        const byId = buildCollectionByKey(allMessagesWithTopicLastMessages, 'id');
        const listedIds = unique(refreshedViewportIds.concat(allMessages.map(({ id }) => id)));

        if (!wasReset) {
          global = resetMessages(global, preservedCurrentThreadsByChatId);

          Object.values(global.byTabId).forEach(({ id: otherTabId }) => {
            global = updateTabState(global, {
              tabThreads: preservedTabThreadsByTabId[otherTabId] || {},
            }, otherTabId);
          });
          wasReset = true;
        }

        global = addChatMessagesById(global, currentChatId, byId);
        if (resultDiscussion) {
          global = updateThreadInfo(global, resultDiscussion.threadInfo);
          global = updateThreadReadState(global, currentChatId, activeThreadId, resultDiscussion.threadReadState);
          global = replaceThreadLocalStateParam(
            global, currentChatId, activeThreadId, 'firstMessageId', resultDiscussion.firstMessageId,
          );
          global = addChatMessagesById(global, currentChatId, buildCollectionByKey(resultDiscussion.topMessages, 'id'));
        }
        global = updateListedIds(global, currentChatId, activeThreadId, listedIds);

        Object.entries(messagesThreads).forEach(([id, thread]) => {
          if (!thread?.threadInfo) return;
          global = updateThreadInfo(global, thread.threadInfo);
        });

        Object.values(global.byTabId).forEach(({ id: otherTabId }) => {
          const { chatId: otherChatId, threadId: otherThreadId } = selectCurrentMessageList(global, otherTabId) || {};
          if (otherChatId === currentChatId && otherThreadId === activeThreadId) {
            const preservedViewportIds = preservedTabThreadsByTabId[otherTabId]
              ?.[currentChatId]?.[activeThreadId]?.viewportIds;
            const mergedMessagesById = selectChatMessages(global, currentChatId) || {};
            const nextViewportIds = preservedViewportIds?.filter((id) => Boolean(mergedMessagesById[id]));

            global = safeReplaceViewportIds(
              global,
              currentChatId,
              activeThreadId,
              nextViewportIds?.length ? nextViewportIds : listedIds,
              otherTabId,
            );
          }
        });
        global = updateChats(global, buildCollectionByKey(result.chats, 'id'));
        global = updateUsers(global, buildCollectionByKey(result.users, 'id'));

        areMessagesLoaded = true;
      }
    }

    setGlobal(global);

    if (currentChat?.isForum) {
      actions.loadTopics({ chatId: currentChatId!, force: true });
      if (currentThreadId && currentThreadId !== MAIN_THREAD_ID) {
        actions.loadTopicById({
          chatId: currentChatId!, topicId: Number(currentThreadId), shouldCloseChatOnError: true,
        });
      }
    }
  }

  global = getGlobal();

  if (!areMessagesLoaded) {
    global = resetMessages(global, preservedCurrentThreadsByChatId);

    Object.values(global.byTabId).forEach(({ id: otherTabId }) => {
      global = updateTabState(global, {
        tabThreads: preservedTabThreadsByTabId[otherTabId] || {},
      }, otherTabId);
    });
  }

  // Restore drafts
  Object.keys(draftsByChatId).forEach((chatId) => {
    const threads = draftsByChatId[chatId];
    Object.keys(threads).forEach((threadId) => {
      global = updateThreadLocalState(global, chatId, Number(threadId), draftsByChatId[chatId][Number(threadId)]);
    });
  });

  setGlobal(global);

  Object.values(global.byTabId).forEach(({ id: tabId }) => {
    const { chatId: audioChatId, messageId: audioMessageId } = selectTabState(global, tabId).audioPlayer;
    if (audioChatId && audioMessageId && !selectChatMessage(global, audioChatId, audioMessageId)) {
      actions.closeAudioPlayer({ tabId });
    }
  });
}

function resetMessages<T extends GlobalState>(
  global: T,
  preservedByChatId: GlobalState['messages']['byChatId'] = {},
) {
  return {
    ...global,
    messages: {
      ...global.messages,
      byChatId: preservedByChatId,
    },
  };
}

function preserveCurrentTabThreads<T extends GlobalState>(global: T) {
  return Object.values(global.byTabId).reduce<Record<number, GlobalState['byTabId'][number]['tabThreads']>>(
    (acc, { id: tabId }) => {
      const currentMessageList = selectCurrentMessageList(global, tabId);
      if (!currentMessageList) {
        return acc;
      }

      const { chatId, threadId = MAIN_THREAD_ID } = currentMessageList;
      const currentTabThread = selectTabState(global, tabId).tabThreads[chatId]?.[threadId];

      if (!currentTabThread) {
        return acc;
      }

      acc[tabId] = {
        [chatId]: {
          [threadId]: currentTabThread,
        },
      };

      return acc;
    },
    {},
  );
}

function preserveCurrentThreads<T extends GlobalState>(global: T) {
  return Object.values(global.byTabId).reduce<GlobalState['messages']['byChatId']>((acc, { id: tabId }) => {
    const currentMessageList = selectCurrentMessageList(global, tabId);
    if (!currentMessageList) {
      return acc;
    }

    const { chatId, threadId = MAIN_THREAD_ID } = currentMessageList;
    const currentThread = global.messages.byChatId[chatId]?.threadsById[threadId];
    if (!currentThread) {
      return acc;
    }

    acc[chatId] = {
      byId: {},
      summaryById: {},
      threadsById: {
        ...acc[chatId]?.threadsById,
        [threadId]: {
          ...currentThread,
          localState: {
            ...currentThread.localState,
            listedIds: undefined,
            outlyingLists: undefined,
          },
        },
      },
    };

    return acc;
  }, {});
}

function resolveDiscussionChat<T extends GlobalState>(
  global: T,
  chatId: string,
  threadId: ThreadId,
) {
  if (threadId === MAIN_THREAD_ID) return undefined;

  const chat = selectChat(global, chatId);
  if (!chat || chat.isForum || getIsSavedDialog(chatId, threadId, global.currentUserId)) return undefined;

  const threadInfo = selectThreadInfo(global, chatId, threadId);
  if (threadInfo?.isCommentsInfo === false && threadInfo.fromChannelId) {
    const originChannel = selectChat(global, threadInfo.fromChannelId);
    if (originChannel && threadInfo.fromMessageId) {
      return { chat: originChannel, messageId: threadInfo.fromMessageId };
    }
  }

  return { chat, messageId: Number(threadId) };
}

function loadTopMessages<T extends GlobalState>(
  global: T,
  chatId: string,
  threadId: ThreadId,
  viewportIds?: number[],
) {
  const currentUserId = global.currentUserId!;
  const isSavedDialog = getIsSavedDialog(chatId, threadId, currentUserId);
  const realChatId = isSavedDialog ? String(threadId) : chatId;

  const chat = selectChat(global, realChatId);
  if (!chat) return undefined;

  const readState = selectThreadReadState(global, chatId, threadId);
  const viewportAnchorId = viewportIds?.[0];
  const shouldRestoreViewport = Boolean(viewportAnchorId && !getIsSavedDialog(chatId, threadId, currentUserId));

  return callApi('fetchMessages', {
    chat,
    threadId,
    offsetId: shouldRestoreViewport ? viewportAnchorId
      : (!isSavedDialog ? readState?.lastReadInboxMessageId : undefined),
    addOffset: shouldRestoreViewport ? -(MESSAGE_LIST_SLICE + 1) : -(Math.round(MESSAGE_LIST_SLICE / 2) + 1),
    limit: shouldRestoreViewport ? (MESSAGE_LIST_SLICE + 1) : MESSAGE_LIST_SLICE,
    isSavedDialog,
  });
}

let previousGlobal: GlobalState | undefined;
// RAF can be unreliable when device goes into sleep mode, so sync logic is handled outside any component
addCallback((global: GlobalState) => {
  const { connectionState, auth, isSynced, isSyncing } = global;
  const { isMasterTab } = selectTabState(global);
  if (!isMasterTab || isSynced || isSyncing || (previousGlobal?.connectionState === connectionState
    && previousGlobal?.auth.state === auth.state)) {
    previousGlobal = global;
    return;
  }

  if (connectionState === 'connectionStateReady' && auth.state === 'authorizationStateReady') {
    previousGlobal = global;
    getActions().sync();
    return;
  }

  previousGlobal = global;
});
