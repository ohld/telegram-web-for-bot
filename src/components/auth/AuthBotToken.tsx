import {
  memo, useEffect, useRef, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';
import type { RegularLangFnParameters } from '../../util/localization';

import {
  DAY, getDays, getHours, getMinutes, HOUR, MINUTE,
} from '../../util/dates/units';
import { getBotAuthFloodWaitSeconds } from '../../util/sessions';

import useForceUpdate from '../../hooks/useForceUpdate';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';
import InputText from '../ui/InputText';
import Loading from '../ui/Loading';

type StateProps = {
  auth: GlobalState['auth'];
  connectionState: GlobalState['connectionState'];
};

const MIN_BOT_TOKEN_LENGTH = 10;
const BOT_TOKEN_RE = /^\d{5,20}:[A-Za-z0-9_-]{30,}$/;
const COOLDOWN_REFRESH_MS = 1000;
const AUTHOR_URL = 'https://t.me/danokhlopkov';
const SOURCE_URL = 'https://github.com/ohld/telegram-web-for-bot';
const WEBSITE_URL = 'https://okhlopkov.com';

const AuthBotToken = ({
  auth,
  connectionState,
}: StateProps) => {
  const {
    setAuthBotToken,
    clearAuthErrorKey,
  } = getActions();

  const {
    state,
    isLoading: authIsLoading,
    errorKey,
  } = auth;

  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>();
  const [botToken, setBotToken] = useState('');
  const forceUpdate = useForceUpdate();

  const isConnected = connectionState === 'connectionStateReady';
  const isAuthReady = state === 'authorizationStateWaitBotToken';
  const normalizedBotToken = botToken.trim();
  const isFloodWaitError = errorKey?.key === 'ErrorFloodTime';
  const floodWaitSeconds = getBotAuthFloodWaitSeconds();
  const isActiveFloodWaitError = Boolean(floodWaitSeconds);
  const visibleErrorKey = floodWaitSeconds
    ? buildFloodWaitErrorKey(floodWaitSeconds)
    : isFloodWaitError ? undefined : errorKey;
  const canSubmit = normalizedBotToken.length >= MIN_BOT_TOKEN_LENGTH
    && BOT_TOKEN_RE.test(normalizedBotToken)
    && !isActiveFloodWaitError;

  useEffect(() => {
    if (isConnected && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isConnected]);

  useEffect(() => {
    if (!floodWaitSeconds) {
      if (isFloodWaitError) {
        clearAuthErrorKey();
      }

      return undefined;
    }

    const interval = window.setInterval(() => {
      if (isFloodWaitError) {
        clearAuthErrorKey();
      }

      forceUpdate();
    }, COOLDOWN_REFRESH_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [clearAuthErrorKey, floodWaitSeconds, forceUpdate, isFloodWaitError]);

  const handleBotTokenChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (visibleErrorKey && !isActiveFloodWaitError) {
      clearAuthErrorKey();
    }

    setBotToken(e.target.value);
  });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (authIsLoading || !canSubmit) {
      return;
    }

    setAuthBotToken({ botToken: normalizedBotToken });
  }

  return (
    <div id="auth-bot-token-form" className="custom-scroll">
      <div className="auth-form">
        <div id="logo" />
        <h1>{lang('BotTokenAuthTitle')}</h1>
        <p className="note">{lang('BotTokenAuthText')}</p>
        <form className="form" action="" onSubmit={handleSubmit}>
          <InputText
            ref={inputRef}
            id="sign-in-bot-token"
            label={lang('BotTokenPlaceholder')}
            value={botToken}
            error={visibleErrorKey && lang.withRegular(visibleErrorKey)}
            inputType="password"
            onChange={handleBotTokenChange}
          />
          <p className="auth-credit">
            {lang.with({
              key: 'BotTokenAuthCredit',
              variables: {
                author: renderAuthCreditLink(AUTHOR_URL, '@danokhlopkov'),
                source: renderAuthCreditLink(SOURCE_URL, lang('BotTokenAuthOpenSource')),
                website: renderAuthCreditLink(WEBSITE_URL, 'okhlopkov.com'),
              },
              options: { withNodes: true },
            })}
          </p>
          {canSubmit && (
            isAuthReady ? (
              <Button
                className="auth-button"
                type="submit"
                ripple
                isLoading={authIsLoading}
              >
                {lang('BotTokenLogin')}
              </Button>
            ) : (
              <Loading />
            )
          )}
        </form>
      </div>
    </div>
  );
};

function buildFloodWaitErrorKey(seconds: number): RegularLangFnParameters {
  return {
    key: 'ErrorFloodTime',
    variables: { time: buildWaitTimeKey(seconds) },
  };
}

function buildWaitTimeKey(seconds: number): RegularLangFnParameters {
  if (seconds < MINUTE) {
    return {
      key: 'Seconds',
      variables: { count: seconds },
      options: { pluralValue: seconds },
    };
  }

  if (seconds < HOUR) {
    const minutes = getMinutes(seconds);
    return {
      key: 'Minutes',
      variables: { count: minutes },
      options: { pluralValue: minutes },
    };
  }

  if (seconds < DAY) {
    const hours = getHours(seconds);
    return {
      key: 'Hours',
      variables: { count: hours },
      options: { pluralValue: hours },
    };
  }

  const days = getDays(seconds);
  return {
    key: 'Days',
    variables: { count: days },
    options: { pluralValue: days },
  };
}

function renderAuthCreditLink(url: string, label: string) {
  return (
    <a
      className="auth-credit-link"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {label}
    </a>
  );
}

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    const {
      auth,
      connectionState,
    } = global;

    return {
      auth,
      connectionState,
    };
  },
)(AuthBotToken));
