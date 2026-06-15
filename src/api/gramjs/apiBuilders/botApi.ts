import type {
  ApiStarGiftRegular,
  ApiSticker,
} from '../../types';

import { int2hex } from '../../../util/colors';

export type BotApiPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};

export type BotApiSticker = {
  file_id: string;
  file_unique_id: string;
  type?: string;
  width: number;
  height: number;
  is_animated?: boolean;
  is_video?: boolean;
  thumbnail?: BotApiPhotoSize;
  emoji?: string;
  file_size?: number;
};

type BotApiGiftBackground = {
  center_color: number;
  edge_color: number;
  text_color: number;
};

export type BotApiGift = {
  id: string;
  sticker: BotApiSticker;
  star_count: number;
  upgrade_star_count?: number;
  is_premium?: true;
  total_count?: number;
  remaining_count?: number;
  personal_total_count?: number;
  personal_remaining_count?: number;
  background?: BotApiGiftBackground;
};

export type BotApiGifts = {
  gifts: BotApiGift[];
};

export function buildApiStarGiftFromBotApiGift(gift: BotApiGift): ApiStarGiftRegular {
  const {
    id,
    sticker,
    star_count: stars,
    upgrade_star_count: upgradeStars,
    is_premium: requirePremium,
    total_count: availabilityTotal,
    remaining_count: availabilityRemains,
    personal_total_count: perUserTotal,
    personal_remaining_count: perUserRemains,
    background,
  } = gift;

  const isLimited = availabilityTotal !== undefined;

  return {
    type: 'starGift',
    isBotApiGift: true,
    id,
    isLimited: isLimited ? true : undefined,
    sticker: buildBotApiSticker(sticker),
    stars,
    availabilityRemains,
    availabilityTotal,
    starsToConvert: 0,
    isSoldOut: availabilityRemains === 0 ? true : undefined,
    upgradeStars,
    requirePremium,
    limitedPerUser: perUserTotal !== undefined ? true : undefined,
    perUserTotal,
    perUserRemains,
    background: buildBotApiGiftBackground(background),
  };
}

function buildBotApiSticker(sticker: BotApiSticker): ApiSticker {
  const isVideo = Boolean(sticker.is_video);

  return {
    mediaType: 'sticker',
    id: sticker.file_unique_id,
    stickerSetInfo: { isMissing: true },
    botApiFileId: sticker.file_id,
    botApiFileUniqueId: sticker.file_unique_id,
    botApiPreviewFileId: sticker.thumbnail?.file_id,
    botApiFileSize: sticker.file_size,
    emoji: sticker.emoji,
    isCustomEmoji: sticker.type === 'custom_emoji' ? true : undefined,
    isLottie: !isVideo && Boolean(sticker.is_animated),
    isVideo,
    width: sticker.width,
    height: sticker.height,
  };
}

function buildBotApiGiftBackground(background?: BotApiGiftBackground) {
  if (!background) {
    return undefined;
  }

  return {
    centerColor: int2hex(background.center_color),
    edgeColor: int2hex(background.edge_color),
    textColor: int2hex(background.text_color),
  };
}
