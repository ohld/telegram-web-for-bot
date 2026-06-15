import { buildApiStarGiftFromBotApiGift } from '../apiBuilders/botApi';

type TestBotApiGift = Parameters<typeof buildApiStarGiftFromBotApiGift>[0];

describe('buildApiStarGiftFromBotApiGift', () => {
  it('maps sendable bot gifts to regular star gifts', () => {
    const gift = {
      id: 'gift-id',
      sticker: {
        file_id: 'sticker-file-id',
        file_unique_id: 'sticker-file-unique-id',
        type: 'custom_emoji',
        width: 512,
        height: 512,
        is_animated: true,
        emoji: 'gift',
        file_size: 4096,
        thumbnail: {
          file_id: 'thumb-file-id',
          file_unique_id: 'thumb-file-unique-id',
          width: 128,
          height: 128,
        },
      },
      star_count: 25,
      upgrade_star_count: 100,
      is_premium: true,
      total_count: 1000,
      remaining_count: 0,
      personal_total_count: 2,
      personal_remaining_count: 1,
      background: {
        center_color: 0x123456,
        edge_color: 0x654321,
        text_color: 0xffffff,
      },
    } satisfies TestBotApiGift;

    expect(buildApiStarGiftFromBotApiGift(gift)).toEqual({
      type: 'starGift',
      isBotApiGift: true,
      id: 'gift-id',
      isLimited: true,
      sticker: {
        mediaType: 'sticker',
        id: 'sticker-file-unique-id',
        stickerSetInfo: { isMissing: true },
        botApiFileId: 'sticker-file-id',
        botApiFileUniqueId: 'sticker-file-unique-id',
        botApiPreviewFileId: 'thumb-file-id',
        botApiFileSize: 4096,
        emoji: 'gift',
        isCustomEmoji: true,
        isLottie: true,
        isVideo: false,
        width: 512,
        height: 512,
      },
      stars: 25,
      availabilityRemains: 0,
      availabilityTotal: 1000,
      starsToConvert: 0,
      isSoldOut: true,
      upgradeStars: 100,
      requirePremium: true,
      limitedPerUser: true,
      perUserTotal: 2,
      perUserRemains: 1,
      background: {
        centerColor: '#123456',
        edgeColor: '#654321',
        textColor: '#ffffff',
      },
    });
  });
});
