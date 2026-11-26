/**
 * Turning what somebody typed, pasted or said into separate shopping-list
 * items. "Milk, eggs and bread" is three things; "salt and vinegar crisps" is
 * one; a list pasted from a note, one per line and perhaps bulleted or
 * numbered, is as many as it has lines.
 *
 * No DOM and nothing at import time, so the tests can load it in node.
 */

import { splitRunOn } from './grocery-words.js';

/** Matches GROCERY_NAME_MAX on the server; a longer item would be refused. */
export const MAX_ITEM_LENGTH = 80;

/**
 * Things that have "and" (or "&") in their name. Splitting on "and" is how
 * almost every list is written or said, so these are the exceptions kept
 * whole. Matched as whole words, "and" or "&" either way.
 */
const COMPOUNDS = [
  'salt and vinegar',
  'salt and pepper',
  'sour cream and onion',
  'cheese and onion',
  'fish and chips',
  'mac and cheese',
  'macaroni and cheese',
  'ham and cheese',
  'bread and butter',
  'peanut butter and jelly',
  'peanut butter and jam',
  'sweet and sour',
  'strawberries and cream',
  'cookies and cream',
  'half and half',
  'pork and beans',
  'franks and beans',
  'chips and salsa',
  'rice and peas',
  'oil and vinegar',
  'bangers and mash',
  'fruit and nut',
  'surf and turf',
];

const COMPOUND_PATTERNS = COMPOUNDS.map((phrase) => {
  const words = phrase.split(' ').map((word) => (word === 'and' ? '(?:and|&)' : escape(word)));
  return new RegExp(`\\b${words.join('\\s+')}\\b`, 'gi');
});

// What people actually say before the list itself, longest first so "can you
// add" wins over "add". Stripped repeatedly: "please can you add …". Spoken
// input only — typed text says what it means.
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
  'add', 'and', '&', 'also', 'please', 'plus', 'some', 'a', 'an', 'the', 'um', 'uh', 'er', 'erm',
  'ok', 'okay', 'thanks', 'thank you', 'get', 'buy', 'put', 'comma',
]);

// A placeholder that cannot occur in anything typed, for an "and" that belongs
// to a name and must survive the split.
const KEPT_AND = '\u0000';

/**
 * Splits a list into items.
 *
 * - On new lines, commas and semicolons always.
 * - On "and", "&" (with spaces round it, so "M&Ms" stays whole) and, for
 *   speech, "plus" — except inside the names above.
 * - Strips bullets and numbering ("- milk", "• eggs", "2. bread"), a leading
 *   "and" left by "milk, eggs, and bread", and trailing full stops.
 * - Spoken input also loses its lead-in ("can you add …"), its tail ("… to
 *   the list"), a leading "some"/"a"/"an", and the dictated word "comma"; and
 *   a run said without separators is split where every word is a known
 *   grocery item (see grocery-words.js).
 * - Drops repeats, whatever their case, and anything that is only filler.
 * - Clamps each item to what the store accepts, and capitalises one written
 *   all in lower case — "milk" becomes "Milk", "iPad charger" is left alone.
 */
export function splitItems(input, { spoken = false, max = MAX_ITEM_LENGTH } = {}) {
  if (typeof input !== 'string') return [];

  let text = input.replace(/[‘’]/g, "'").replace(/\r\n?/g, '\n');
  if (spoken) text = text.replace(/\bcomma\b/gi, ',');
  for (const pattern of COMPOUND_PATTERNS) {
    text = text.replace(pattern, (match) => match.replace(/\s+(?:and|&)\s+/i, ` ${KEPT_AND} `));
  }

  // Lines first, then each line on its own, so a bullet only has to be
  // recognised at the start of a line.
  const parts = [];
  for (let line of text.split('\n')) {
    line = line.replace(/\s+/g, ' ').trim();
    if (spoken) line = stripEdges(line);
    const separators = spoken
      ? /\s*[,;]\s*|\s+(?:and|&|plus)\s+/i
      : /\s*[,;]\s*|\s+(?:and|&)\s+/i;
    parts.push(...line.split(separators));
  }

  const seen = new Set();
  const items = [];
  for (const part of parts) {
    let item = part
      .replace(/^\s*(?:[-*•·▪◦‣>]+|\d+[.)]|\[[ x]?\])\s+/i, '')
      .replace(/^(?:and|&|plus)\s+/i, '')
      .trim();
    if (spoken) item = stripEdges(item).replace(/^(?:some|a|an)\s+/i, '');
    item = item.replace(/[.!?:]+$/g, '').replace(/\s+/g, ' ').trim();

    // Speech rarely comes with commas: "milk eggs bread coffee beans" is one
    // run of words. Split it where every word is a known item; leave it whole
    // where anything is not, rather than guess.
    const pieces = spoken ? splitRunOn(item.split(KEPT_AND).join('and')) || [item] : [item];

    for (let piece of pieces) {
      piece = piece.split(KEPT_AND).join('and').replace(/\s+/g, ' ').trim();
      if (!piece || FILLER.has(piece.toLowerCase())) continue;

      piece = piece.slice(0, max).trim();
      if (piece === piece.toLocaleLowerCase()) {
        piece = piece.charAt(0).toLocaleUpperCase() + piece.slice(1);
      }

      const key = piece.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(piece);
    }
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

function escape(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
