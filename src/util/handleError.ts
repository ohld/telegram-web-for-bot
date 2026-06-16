import { DEBUG, DEBUG_ALERT_MSG } from '../config';
import { isCurrentTabMaster } from './establishMultitabRole';
import { throttle } from './schedulers';

let showError = true;
let error: Error | undefined;

const RESOURCE_ERROR_TAGS = new Set(['IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'LINK', 'SCRIPT']);
const VIEW_TRANSITION_ABORT_MESSAGE = 'Transition was aborted';
const VIEW_TRANSITION_ABORT_ERROR_NAME = 'InvalidStateError';

window.addEventListener('error', handleErrorEvent);
window.addEventListener('unhandledrejection', handleErrorEvent);

if (DEBUG) {
  window.addEventListener('focus', () => {
    if (!isCurrentTabMaster()) {
      return;
    }
    showError = true;
    if (error) {
      window.alert(getErrorMessage(error));
      error = undefined;
    }
  });
  window.addEventListener('blur', () => {
    if (!isCurrentTabMaster()) {
      return;
    }
    showError = false;
  });
}

const throttleError = throttle((err) => {
  if (showError) {
    window.alert(getErrorMessage(err));
  } else {
    error = err;
  }
}, 1500);

export function handleError(err: Error) {
  // eslint-disable-next-line no-console
  console.error(err);
  if (DEBUG) {
    throttleError(err);
  }
}

function handleErrorEvent(e: ErrorEvent | PromiseRejectionEvent) {
  if (isResourceError(e)) {
    return;
  }

  const err = e instanceof ErrorEvent ? (e.error || e.message) : e.reason;
  if (isExpectedViewTransitionAbort(err)) {
    e.preventDefault();
    return;
  }

  if (e instanceof ErrorEvent) {
    // https://stackoverflow.com/questions/49384120/resizeobserver-loop-limit-exceeded
    if (e.message === 'ResizeObserver loop limit exceeded') {
      return;
    }

    // Flood wait errors
    if (e.message.includes('A wait of')) {
      return;
    }
  }

  e.preventDefault();
  handleError(err);
}

function isResourceError(e: Event | PromiseRejectionEvent) {
  const target = e instanceof PromiseRejectionEvent && e.reason instanceof Event
    ? e.reason.target
    : e.target;

  return target instanceof Element && RESOURCE_ERROR_TAGS.has(target.tagName);
}

function isExpectedViewTransitionAbort(err: unknown) {
  if (err instanceof DOMException || err instanceof Error) {
    return err.name === VIEW_TRANSITION_ABORT_ERROR_NAME
      && err.message.includes(VIEW_TRANSITION_ABORT_MESSAGE);
  }

  return typeof err === 'string' && err.includes(VIEW_TRANSITION_ABORT_MESSAGE);
}

function getErrorMessage(err: Error) {
  return `${DEBUG_ALERT_MSG}\n\n${(err?.message) || err}\n${err?.stack}`;
}
