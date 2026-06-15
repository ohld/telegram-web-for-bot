import type {
  ApiMessage, ApiSticker, ApiStickerSet, ApiVideo,
} from '../../api/types';
import type { GlobalState, TabArgs } from '../types';

import { getCurrentTabId } from '../../util/establishMultitabRole';
import { buildCollectionByKey, unique } from '../../util/iteratees';
import { selectCustomEmojiForEmoji, selectStickersForEmoji, selectTabState } from '../selectors';
import { updateTabState } from './tabs';

const OBSERVED_GIFS_LIMIT = 100;
const OBSERVED_STICKER_SETS_LIMIT = 50;

export function updateStickerSearch<T extends GlobalState>(
  global: T,
  hash: string,
  resultIds?: string[],
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): T {
  return updateTabState(global, {
    stickerSearch: {
      ...selectTabState(global, tabId).stickerSearch,
      hash,
      resultIds,
    },
  }, tabId);
}

export function updateStickerSets<T extends GlobalState>(
  global: T,
  category: 'added' | 'featured' | 'search',
  hash: string,
  sets: ApiStickerSet[],
): T {
  const updatedSets = sets.map((stickerSet) => {
    const existing = global.stickers.setsById[stickerSet.id];
    if (!existing) {
      return stickerSet;
    }

    return {
      ...existing,
      ...stickerSet,
    };
  });

  const regularSetIds = sets.map((set) => set.id);

  if (category === 'search') {
    return {
      ...global,
      stickers: {
        ...global.stickers,
        setsById: {
          ...global.stickers.setsById,
          ...buildCollectionByKey(updatedSets, 'id'),
        },
      },
    };
  }

  return {
    ...global,
    stickers: {
      ...global.stickers,
      setsById: {
        ...global.stickers.setsById,
        ...buildCollectionByKey(updatedSets, 'id'),
      },
      [category]: {
        ...global.stickers[category],
        hash,
        setIds: [
          ...(global.stickers[category].setIds || []),
          ...regularSetIds,
        ],
      },
    },
  };
}

export function updateCustomEmojiSets<T extends GlobalState>(
  global: T,
  hash: string,
  sets: ApiStickerSet[],
): T {
  const updatedSets = sets.map((stickerSet) => {
    const existing = global.stickers.setsById[stickerSet.id];
    if (!existing) {
      return stickerSet;
    }

    return {
      ...existing,
      ...stickerSet,
    };
  });

  const customEmojis = sets.map((set) => set.stickers).flat().filter(Boolean);
  const addedSetIds = sets.map((set) => set.id);

  return {
    ...global,
    stickers: {
      ...global.stickers,
      setsById: {
        ...global.stickers.setsById,
        ...buildCollectionByKey(updatedSets, 'id'),
      },
    },
    customEmojis: {
      ...global.customEmojis,
      added: {
        ...global.customEmojis.added,
        hash,
        setIds: [
          ...(global.customEmojis.added.setIds || []),
          ...addedSetIds,
        ],
      },
      byId: {
        ...global.customEmojis.byId,
        ...buildCollectionByKey(customEmojis, 'id'),
      },
    },
  };
}

export function updateStickerSet<T extends GlobalState>(
  global: T, stickerSetId: string, update: Partial<ApiStickerSet>,
): T {
  const currentStickerSet = global.stickers.setsById[stickerSetId] || {};
  const isCustomEmoji = update.isEmoji || currentStickerSet.isEmoji;
  const addedSets = (isCustomEmoji ? global.customEmojis.added.setIds : global.stickers.added.setIds) || [];
  let setIds: string[] = addedSets;
  if (update.installedDate && !update.isArchived && addedSets && !addedSets.includes(stickerSetId)) {
    setIds = [stickerSetId, ...setIds];
  }

  if (!update.installedDate && addedSets?.includes(stickerSetId)) {
    setIds = setIds.filter((id) => id !== stickerSetId);
  }

  const customEmojiById = isCustomEmoji && update.stickers && buildCollectionByKey(update.stickers, 'id');

  return {
    ...global,
    stickers: {
      ...global.stickers,
      added: {
        ...global.stickers.added,
        ...(!isCustomEmoji && { setIds }),
      },
      setsById: {
        ...global.stickers.setsById,
        [stickerSetId]: {
          ...currentStickerSet,
          ...update,
        },
      },
    },
    customEmojis: {
      ...global.customEmojis,
      byId: {
        ...global.customEmojis.byId,
        ...customEmojiById,
      },
      added: {
        ...global.customEmojis.added,
        ...(isCustomEmoji && { setIds }),
      },
    },
  };
}

export function updateObservedSymbols<T extends GlobalState>(
  global: T, messages: ApiMessage[],
): T {
  global = updateObservedStickerSets(global, messages);
  return updateObservedGifs(global, messages);
}

export function updateGifSearch<T extends GlobalState>(
  global: T, isNew: boolean, results: ApiVideo[], nextOffset?: string,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): T {
  const { results: currentResults } = selectTabState(global, tabId).gifSearch;

  let newResults!: ApiVideo[];
  if (isNew || !currentResults) {
    newResults = results;
  } else {
    const currentIds = new Set(currentResults.map((gif) => gif.id));
    newResults = [
      ...currentResults,
      ...results.filter((gif) => !currentIds.has(gif.id)),
    ];
  }

  return updateTabState(global, {
    gifSearch: {
      ...selectTabState(global, tabId).gifSearch,
      offset: nextOffset,
      results: newResults,
    },
  }, tabId);
}

export function replaceAnimatedEmojis<T extends GlobalState>(global: T, stickerSet: ApiStickerSet): T {
  return {
    ...global,
    animatedEmojis: stickerSet,
  };
}

function updateObservedStickerSets<T extends GlobalState>(
  global: T, messages: ApiMessage[],
): T {
  const stickers = messages.reduce<ApiSticker[]>((acc, { content }) => {
    if (content.sticker) {
      acc.push(content.sticker);
    }

    return acc;
  }, []);
  if (!stickers.length) {
    return global;
  }

  let setIds = global.stickers.observed.setIds || [];
  let setsById = global.stickers.setsById;
  let hasChanges = false;

  stickers.forEach((sticker) => {
    if (sticker.isCustomEmoji || !('id' in sticker.stickerSetInfo)) {
      return;
    }

    const { id, accessHash } = sticker.stickerSetInfo;
    const existing = setsById[id];

    if (existing?.stickers && existing.count === existing.stickers.length) {
      if (!setIds.includes(id)) {
        setIds = [id, ...setIds].slice(0, OBSERVED_STICKER_SETS_LIMIT);
        hasChanges = true;
      }
      return;
    }

    const existingStickers = existing?.stickers || [];
    const isKnownSticker = existingStickers.some(({ id: stickerId }) => stickerId === sticker.id);
    const updatedStickers = isKnownSticker
      ? existingStickers
      : [sticker, ...existingStickers];
    const count = existing ? Math.max(existing.count, updatedStickers.length + 1) : updatedStickers.length + 1;

    if (!existing) {
      setsById = {
        ...setsById,
        [id]: {
          id,
          accessHash,
          title: '',
          count,
          stickers: updatedStickers,
          shortName: '',
        },
      };
      hasChanges = true;
    } else if (!isKnownSticker || existing.accessHash !== accessHash || existing.count !== count) {
      setsById = {
        ...setsById,
        [id]: {
          ...existing,
          accessHash,
          count,
          stickers: updatedStickers,
        },
      };
      hasChanges = true;
    }

    if (!setIds.includes(id)) {
      setIds = [id, ...setIds].slice(0, OBSERVED_STICKER_SETS_LIMIT);
      hasChanges = true;
    }
  });

  if (!hasChanges) {
    return global;
  }

  return {
    ...global,
    stickers: {
      ...global.stickers,
      setsById,
      observed: {
        ...global.stickers.observed,
        setIds,
      },
    },
  };
}

function updateObservedGifs<T extends GlobalState>(
  global: T, messages: ApiMessage[],
): T {
  const gifs = messages.reduce<ApiVideo[]>((acc, { content }) => {
    if (content.video?.isGif) {
      acc.push(content.video);
    }

    return acc;
  }, []);
  if (!gifs.length) {
    return global;
  }

  let savedGifs = global.gifs.saved.gifs || [];
  gifs.forEach((gif) => {
    savedGifs = [
      gif,
      ...savedGifs.filter(({ id }) => id !== gif.id),
    ];
  });

  savedGifs = savedGifs.slice(0, OBSERVED_GIFS_LIMIT);

  return {
    ...global,
    gifs: {
      ...global.gifs,
      saved: {
        ...global.gifs.saved,
        gifs: savedGifs,
      },
    },
  };
}

export function updateStickersForEmoji<T extends GlobalState>(
  global: T, emoji: string, remoteStickers?: ApiSticker[], hash?: string,
): T {
  const localStickers = selectStickersForEmoji(global, emoji);
  const allStickers = [...localStickers, ...(remoteStickers || [])];
  const uniqueIds = unique(allStickers.map(({ id }) => id));
  const byId = buildCollectionByKey(allStickers, 'id');
  const stickers = uniqueIds.map((id) => byId[id]);

  return {
    ...global,
    stickers: {
      ...global.stickers,
      forEmoji: {
        emoji,
        stickers,
        hash,
      },
    },
  };
}

export function updateCustomEmojiForEmoji<T extends GlobalState>(
  global: T, emoji: string,
): T {
  const localStickers = selectCustomEmojiForEmoji(global, emoji);
  const uniqueIds = unique(localStickers.map(({ id }) => id));
  const byId = buildCollectionByKey(localStickers, 'id');
  const stickers = uniqueIds.map((id) => byId[id]);

  return {
    ...global,
    customEmojis: {
      ...global.customEmojis,
      forEmoji: {
        emoji,
        stickers,
      },
    },
  };
}

export function updateRecentStatusCustomEmojis<T extends GlobalState>(
  global: T, hash: string, emojis: ApiSticker[],
): T {
  return {
    ...global,
    customEmojis: {
      ...global.customEmojis,
      statusRecent: {
        ...global.customEmojis.statusRecent,
        hash,
        emojis,
      },
    },
  };
}

export function rebuildStickersForEmoji<T extends GlobalState>(global: T): T {
  if (global.stickers.forEmoji) {
    const { emoji, stickers, hash } = global.stickers.forEmoji;
    if (!emoji) {
      return global;
    }

    return updateStickersForEmoji(global, emoji, stickers, hash);
  }

  if (global.customEmojis.forEmoji) {
    const { emoji } = global.customEmojis.forEmoji;
    if (!emoji) {
      return global;
    }

    return updateCustomEmojiForEmoji(global, emoji);
  }

  return global;
}
