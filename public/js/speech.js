/**
 * Voice input for the shopping list.
 *
 * Two halves. `parseSpokenItems` turns what somebody said — "add bananas,
 * coffee beans and tin foil" — into the separate things they meant. The rest is
 * a thin wrapper over the browser's own SpeechRecognition: no key, no account,
 * nothing of ours in the middle. (The browser may hand the audio to its own
 * vendor's recogniser; that is between the household and their browser.)
 *
 * Nothing here touches the DOM at import time, so the tests can load it in node
 * and hand it a pretend browser.
 */

import { MAX_ITEM_LENGTH, splitItems } from './listparse.js';

export { MAX_ITEM_LENGTH };

/**
 * "add bananas, coffee beans and tin foil" → ['Bananas', 'Coffee beans', 'Tin foil'].
 *
 * The shared list rules (see listparse.js) plus what only speech needs: the
 * lead-in and tail people say, "plus", and the dictated word "comma". Saying
 * only "add" adds nothing.
 */
export function parseSpokenItems(transcript, { max = MAX_ITEM_LENGTH } = {}) {
  return splitItems(transcript, { spoken: true, max });
}

// -- the recogniser ---------------------------------------------------------

/**
 * Whether voice can work here, and if not, why — so the page can hide the mic
 * and say so instead of offering a button that does nothing. Browsers only
 * allow the microphone on a secure page: https, or localhost. A household
 * install opened as http://192.168.x.x is neither.
 */
export function voiceSupport(env = globalThis) {
  const Recognizer = env?.SpeechRecognition || env?.webkitSpeechRecognition;
  if (!Recognizer) {
    return {
      available: false,
      reason: 'unsupported',
      message: 'This browser cannot take dictation — type items instead.',
    };
  }
  if (env.isSecureContext === false) {
    return {
      available: false,
      reason: 'insecure',
      message:
        'Voice needs a secure address (https, or localhost on this machine). '
        + 'Over plain http on the home network the browser will not open the microphone.',
    };
  }
  return { available: true, reason: null, message: '', Recognizer };
}

const ERROR_MESSAGES = {
  'not-allowed': 'Microphone access was refused — allow it in the browser to use voice',
  'service-not-allowed': 'Microphone access was refused — allow it in the browser to use voice',
  'no-speech': 'Didn’t catch anything — try again',
  'audio-capture': 'No microphone was found',
  network: 'The speech service could not be reached',
  aborted: null,
};

/**
 * Listens for one phrase. Calls `onItems` with the parsed items (possibly
 * none), `onError` with something sayable, and `onEnd` once either way.
 * Returns a function that stops listening early.
 */
export function listenOnce({ onItems, onError, onEnd, onStart, lang } = {}, env = globalThis) {
  const support = voiceSupport(env);
  if (!support.available) {
    onError?.(support.message);
    onEnd?.();
    return () => {};
  }

  const recognition = new support.Recognizer();
  recognition.lang = lang || env.navigator?.language || 'en-GB';
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onEnd?.();
  };

  recognition.onstart = () => onStart?.();
  recognition.onresult = (event) => {
    const said = Array.from(event.results || [])
      .map((result) => result[0]?.transcript || '')
      .join(' ');
    onItems?.(parseSpokenItems(said), said);
  };
  recognition.onerror = (event) => {
    const message = ERROR_MESSAGES[event.error];
    if (message !== null) onError?.(message || 'Voice input stopped unexpectedly');
  };
  recognition.onend = finish;

  try {
    recognition.start();
  } catch {
    onError?.('Voice input is already listening');
    finish();
  }

  return () => {
    try {
      recognition.stop();
    } catch {
      // Already stopped.
    }
  };
}
