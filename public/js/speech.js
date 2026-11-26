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

/** Matches GROCERY_NAME_MAX on the server; a longer item would be refused. */
export const MAX_ITEM_LENGTH = 80;

// What people actually say before the list itself, longest first so "can you
// add" wins over "add". Stripped repeatedly: "please can you add …".
const LEAD_INS = [
  'can you please add',
  'could you please add',
  'can you add',
  'could you add',
  'will you add',
  'would you add',
  'please add',
  'we are out of',
  "we're out of",
  'we have run out of',
  "we've run out of",
  'we need some',
  'we need',
  'i need',
  'we want',
  'remember to get',
  'remember',
  'put',
  'add',
  'get',
  'buy',
  'please',
  'okay',
  'ok',
  'also',
  'and',
];

// The tail people add: "… to the shopping list, thanks".
const TAILS = [
  'to the shopping list',
  'on the shopping list',
  'to the list',
  'on the list',
  'to shopping',
  'please',
  'thanks',
  'thank you',
];

// Words that are never an item on their own. Saying just "add" must add
// nothing — an item called "Add" is exactly the bug this guards against.
const FILLER = new Set([
  'add', 'and', 'also', 'please', 'plus', 'some', 'a', 'an', 'the', 'um', 'uh', 'er', 'erm',
  'ok', 'okay', 'thanks', 'thank you', 'get', 'buy', 'put', 'comma',
]);

/**
 * "add bananas, coffee beans and tin foil" → ['Bananas', 'Coffee beans', 'Tin foil'].
 *
 * Splits on commas, semicolons, "and", "&", "plus" and the dictated word
 * "comma"; strips the lead-in and the tail; drops repeats; clamps each item to
 * what the store accepts. "Salt and vinegar crisps" comes back as two items —
 * the price of splitting on "and", which is how almost every list is said.
 */
export function parseSpokenItems(transcript, { max = MAX_ITEM_LENGTH } = {}) {
  if (typeof transcript !== 'string') return [];

  let text = transcript
    .replace(/[‘’]/g, "'")
    .replace(/\bcomma\b/gi, ',')
    .replace(/\s+/g, ' ')
    .trim();

  text = stripEdges(text);

  const seen = new Set();
  const items = [];
  for (const part of text.split(/\s*(?:[,;&]|\band\b|\bplus\b)\s*/i)) {
    let item = stripEdges(part)
      .replace(/^(?:some|a|an)\s+/i, '')
      .replace(/[.!?:]+$/g, '')
      .trim();
    if (!item || FILLER.has(item.toLowerCase())) continue;

    item = item.slice(0, max).trim();
    item = item.charAt(0).toLocaleUpperCase() + item.slice(1);

    const key = item.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

function stripEdges(value) {
  let text = value.trim().replace(/^[,;.\s]+|[,;.!?\s]+$/g, '');
  let changed = true;
  while (changed && text) {
    changed = false;
    const lower = text.toLowerCase();
    for (const lead of LEAD_INS) {
      if (lower === lead) {
        text = '';
        changed = true;
        break;
      }
      if (lower.startsWith(`${lead} `) || lower.startsWith(`${lead},`)) {
        text = text.slice(lead.length).replace(/^[,\s]+/, '');
        changed = true;
        break;
      }
    }
    if (changed) continue;
    for (const tail of TAILS) {
      if (lower.endsWith(` ${tail}`) || lower.endsWith(`,${tail}`)) {
        text = text.slice(0, text.length - tail.length).replace(/[,\s]+$/, '');
        changed = true;
        break;
      }
    }
  }
  return text;
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
