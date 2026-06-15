import { Api as GramJs } from '../../../lib/gramjs';

import type {
  ApiFormattedText,
  ApiPremiumGiftCodeOption,
  ApiReaction,
  ApiStarGiftRegular,
  ApiTypeCurrencyAmount,
} from '../../types';
import type { BotApiGifts } from '../apiBuilders/botApi';

import { STARS_CURRENCY_CODE } from '../../../config';
import { isUserId } from '../../../util/entities/ids';
import { buildApiStarGiftFromBotApiGift } from '../apiBuilders/botApi';
import { invokeRequest, isBotApiSession } from './client';

type BotApiResponse<T> = {
  ok?: boolean;
  result?: T;
  description?: string;
};

type BotApiRequestResult<T> = {
  result?: T;
  error?: string;
};

type BotApiStarAmount = {
  amount: number;
  nanostar_amount?: number;
};

type BotApiStarsStatus = {
  balance: ApiTypeCurrencyAmount;
  nextHistoryOffset?: string;
  history?: undefined;
  nextSubscriptionOffset?: string;
  subscriptions?: undefined;
};

type BotApiSendResult = {
  success?: true;
  error?: string;
};

type BotApiReaction = {
  type: 'emoji';
  emoji: string;
} | {
  type: 'custom_emoji';
  custom_emoji_id: string;
};

type BotApiStarGifts = {
  gifts: ApiStarGiftRegular[];
  chats?: undefined;
  users?: undefined;
};

const BOT_API_PREMIUM_GIFT_OPTIONS: ApiPremiumGiftCodeOption[] = [{
  users: 1,
  months: 3,
  currency: STARS_CURRENCY_CODE,
  amount: 1000,
}, {
  users: 1,
  months: 6,
  currency: STARS_CURRENCY_CODE,
  amount: 1500,
}, {
  users: 1,
  months: 12,
  currency: STARS_CURRENCY_CODE,
  amount: 2500,
}];

export function getBotApiPremiumGiftCodeOptions() {
  if (!isBotApiSession()) {
    return undefined;
  }

  return BOT_API_PREMIUM_GIFT_OPTIONS;
}

export async function fetchBotApiStarBalance(): Promise<BotApiStarsStatus | undefined> {
  const response = await invokeBotApiRequest<BotApiStarAmount>('getMyStarBalance');
  const result = response?.result;
  if (!result) {
    return undefined;
  }

  return {
    balance: {
      currency: STARS_CURRENCY_CODE,
      amount: result.amount,
      nanos: result.nanostar_amount || 0,
    },
  };
}

export async function fetchBotApiAvailableGifts(): Promise<BotApiStarGifts | undefined> {
  const response = await invokeBotApiRequest<BotApiGifts>('getAvailableGifts');
  const result = response?.result;
  if (!result) {
    return undefined;
  }

  return {
    gifts: result.gifts.map(buildApiStarGiftFromBotApiGift),
  };
}

export async function sendBotApiGift({
  peerId,
  giftId,
  message,
  shouldUpgrade,
}: {
  peerId: string;
  giftId: string;
  message?: ApiFormattedText;
  shouldUpgrade?: boolean;
}): Promise<BotApiSendResult | undefined> {
  const response = await invokeBotApiRequest<boolean>('sendGift', {
    gift_id: giftId,
    user_id: isUserId(peerId) ? Number(peerId) : undefined,
    chat_id: !isUserId(peerId) ? Number(peerId) : undefined,
    pay_for_upgrade: shouldUpgrade ? true : undefined,
    text: message?.text,
  });

  return buildBotApiSendResult(response);
}

export async function sendBotApiPremiumGift({
  userId,
  months,
  amount,
  message,
}: {
  userId: string;
  months: number;
  amount: number;
  message?: ApiFormattedText;
}): Promise<BotApiSendResult | undefined> {
  const response = await invokeBotApiRequest<boolean>('giftPremiumSubscription', {
    user_id: Number(userId),
    month_count: months,
    star_count: amount,
    text: message?.text,
  });

  return buildBotApiSendResult(response);
}

export async function sendBotApiReaction({
  chatId,
  messageId,
  reactions,
}: {
  chatId: string;
  messageId: number;
  reactions?: ApiReaction[];
}): Promise<BotApiSendResult | undefined> {
  const response = await invokeBotApiRequest<boolean>('setMessageReaction', {
    chat_id: Number(chatId),
    message_id: messageId,
    reaction: reactions?.map(buildBotApiReaction) || [],
  });

  return buildBotApiSendResult(response);
}

async function invokeBotApiRequest<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<BotApiRequestResult<T> | undefined> {
  if (!isBotApiSession()) {
    return undefined;
  }

  const SendCustomRequest = GramJs.bots.SendCustomRequest;
  if (!SendCustomRequest) {
    return { error: method };
  }

  const response = await invokeRequest(new SendCustomRequest({
    customMethod: method,
    params: new GramJs.DataJSON({
      data: JSON.stringify(params),
    }),
  }), {
    shouldIgnoreErrors: true,
  }).catch(() => undefined);

  if (!response) {
    return { error: method };
  }

  const data = parseJson(response.data);
  if (!data) {
    return { error: method };
  }

  if (isBotApiResponse<T>(data)) {
    if (data.ok === false) {
      return { error: data.description || method };
    }

    return { result: data.result };
  }

  return { result: data as T };
}

function buildBotApiSendResult(response?: BotApiRequestResult<boolean>): BotApiSendResult | undefined {
  if (!response) {
    return undefined;
  }

  if (response.result) {
    return { success: true };
  }

  return { error: response.error };
}

function buildBotApiReaction(reaction: ApiReaction): BotApiReaction {
  if (reaction.type === 'custom') {
    return {
      type: 'custom_emoji',
      custom_emoji_id: reaction.documentId,
    };
  }

  return {
    type: 'emoji',
    emoji: reaction.emoticon,
  };
}

function parseJson(data: string) {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

function isBotApiResponse<T>(data: unknown): data is BotApiResponse<T> {
  if (!data || typeof data !== 'object') {
    return false;
  }

  return 'ok' in data;
}
