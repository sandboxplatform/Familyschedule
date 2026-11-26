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
 * Listens for a whole list rather than one phrase.
 *
 * The browser's recogniser, left to itself, stops at the first pause — so
 * "milk… eggs… bread" used to add only milk. Here it keeps listening until
 * the person stops talking for a few seconds or taps the mic again, and each
 * pause marks the end of an item: speech rarely arrives with commas, but it
 * does arrive in pause-sized pieces.
 *
 * `onUpdate(items, heard)` fires as words come in, interim ones included, so
 * the screen can fill as somebody speaks; `onDone(items, heard)` fires once at
 * the end with the final list. Returns a function that stops listening.
 */
export function listenForList(
  { onUpdate, onDone, onError, onEnd, onStart, lang, silenceMs = 2500, maxMs = 60000 } = {},
  env = globalThis,
) {
  const support = voiceSupport(env);
  if (!support.available) {
    onError?.(support.message);
    onEnd?.();
    return () => {};
  }

  const recognition = new support.Recognizer();
  recognition.lang = lang || env.navigator?.language || 'en-GB';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  const finals = [];
  let interim = '';
  let heardAnything = false;
  let finished = false;
  const timers = env.setTimeout ? env : globalThis;
  let silenceTimer = null;
  const hardStop = timers.setTimeout(() => stop(), maxMs);

  const snapshot = () => {
    const pieces = interim ? [...finals, interim] : [...finals];
    return { items: itemsFromPieces(pieces), heard: pieces.join(', ') };
  };

  const stop = () => {
    try {
      recognition.stop();
    } catch {
      // Already stopped.
    }
  };

  // A few seconds of quiet after something has been said means the list is
  // done; before anything has been said, the recogniser's own no-speech
  // timeout decides.
  const restartSilence = () => {
    timers.clearTimeout(silenceTimer);
    if (heardAnything) silenceTimer = timers.setTimeout(stop, silenceMs);
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    timers.clearTimeout(silenceTimer);
    timers.clearTimeout(hardStop);
    const { items, heard } = snapshot();
    onDone?.(items, heard);
    onEnd?.();
  };

  recognition.onstart = () => onStart?.();
  recognition.onresult = (event) => {
    interim = '';
    const results = Array.from(event.results || []);
    for (let index = event.resultIndex ?? 0; index < results.length; index += 1) {
      const result = results[index];
      const text = (result[0]?.transcript || '').trim();
      if (!text) continue;
      if (result.isFinal) {
        addFinal(finals, text);
      } else {
        interim = interim ? `${interim} ${text}` : text;
      }
    }
    heardAnything = heardAnything || finals.length > 0 || Boolean(interim);
    restartSilence();
    const { items, heard } = snapshot();
    onUpdate?.(items, heard);
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

  return stop;
}

/**
 * Some recognisers (Chrome on Android among them) hand back each final result
 * as the whole transcript so far — "milk", then "milk eggs" — rather than the
 * new part. A final that merely extends the last one replaces it.
 */
function addFinal(finals, text) {
  const last = finals[finals.length - 1];
  if (last && text.toLowerCase().startsWith(last.toLowerCase())) {
    finals[finals.length - 1] = text;
  } else if (!last || last.toLowerCase() !== text.toLowerCase()) {
    finals.push(text);
  }
}

/** Each pause-separated piece is its own item, or several if it says so. */
export function itemsFromPieces(pieces) {
  return parseSpokenItems(pieces.filter(Boolean).join(', '));
}
