import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSpokenItems, voiceSupport, listenOnce, MAX_ITEM_LENGTH } from '../public/js/speech.js';

// -- the parser -------------------------------------------------------------

test('a spoken list becomes separate items', () => {
  assert.deepEqual(parseSpokenItems('add bananas, coffee beans and tin foil'), [
    'Bananas',
    'Coffee beans',
    'Tin foil',
  ]);
});

test('it splits on every way a list gets said', () => {
  assert.deepEqual(parseSpokenItems('milk; eggs & bread plus butter and jam'), [
    'Milk',
    'Eggs',
    'Bread',
    'Butter',
    'Jam',
  ]);
  assert.deepEqual(parseSpokenItems('apples comma pears comma grapes'), ['Apples', 'Pears', 'Grapes']);
});

test('the lead-in and the tail people actually say are stripped', () => {
  assert.deepEqual(parseSpokenItems('we need milk'), ['Milk']);
  assert.deepEqual(parseSpokenItems('can you add washing up liquid'), ['Washing up liquid']);
  assert.deepEqual(parseSpokenItems('please add rice to the shopping list thanks'), ['Rice']);
  assert.deepEqual(parseSpokenItems('Please can you add oats.'), ['Oats']);
  assert.deepEqual(parseSpokenItems("we're out of teabags"), ['Teabags']);
  assert.deepEqual(parseSpokenItems('add some apples and a loaf of bread'), ['Apples', 'Loaf of bread']);
});

test('saying only the lead-in adds nothing', () => {
  for (const said of ['add', 'Add.', 'please', 'add and', 'and', 'um', 'comma', '', '   ']) {
    assert.deepEqual(parseSpokenItems(said), [], `"${said}" should add nothing`);
  }
  assert.deepEqual(parseSpokenItems(null), []);
  assert.deepEqual(parseSpokenItems(undefined), []);
});

test('repeats are dropped, whatever their case', () => {
  assert.deepEqual(parseSpokenItems('milk and Milk and MILK and eggs'), ['Milk', 'Eggs']);
});

test('each item is clamped to what the store accepts', () => {
  const [item] = parseSpokenItems(`add ${'very '.repeat(40)}long thing`);
  assert.equal(item.length <= MAX_ITEM_LENGTH, true);
  assert.equal(item, item.trim());
});

test('a word that merely contains "and" is not split', () => {
  assert.deepEqual(parseSpokenItems('candles and sandwich bags'), ['Candles', 'Sandwich bags']);
});

// -- the recogniser ---------------------------------------------------------

class FakeRecognizer {
  static last = null;
  constructor() {
    FakeRecognizer.last = this;
    this.started = false;
    this.stopped = false;
  }
  start() {
    this.started = true;
    this.onstart?.();
  }
  stop() {
    this.stopped = true;
    this.onend?.();
  }
  say(transcript) {
    this.onresult?.({ results: [[{ transcript }]] });
    this.onend?.();
  }
  fail(error) {
    this.onerror?.({ error });
    this.onend?.();
  }
}

test('no recogniser in the browser means no mic, and says why', () => {
  const support = voiceSupport({ isSecureContext: true });
  assert.equal(support.available, false);
  assert.equal(support.reason, 'unsupported');
  assert.ok(support.message);
});

test('plain http on the home network means no mic, and says why', () => {
  const support = voiceSupport({ webkitSpeechRecognition: FakeRecognizer, isSecureContext: false });
  assert.equal(support.available, false);
  assert.equal(support.reason, 'insecure');
  assert.match(support.message, /secure|https|localhost/i);
});

test('a secure page with a recogniser gets the mic, prefixed or not', () => {
  assert.equal(voiceSupport({ SpeechRecognition: FakeRecognizer, isSecureContext: true }).available, true);
  assert.equal(voiceSupport({ webkitSpeechRecognition: FakeRecognizer, isSecureContext: true }).available, true);
});

test('listening once hands back parsed items and then ends', () => {
  const env = { SpeechRecognition: FakeRecognizer, isSecureContext: true, navigator: { language: 'en-GB' } };
  const calls = [];
  listenOnce(
    {
      onStart: () => calls.push('start'),
      onItems: (items) => calls.push(items),
      onError: (message) => calls.push(`error: ${message}`),
      onEnd: () => calls.push('end'),
    },
    env,
  );
  const recognizer = FakeRecognizer.last;
  assert.equal(recognizer.started, true);
  assert.equal(recognizer.lang, 'en-GB');
  assert.equal(recognizer.continuous, false);
  recognizer.say('add bananas and tin foil');
  assert.deepEqual(calls, ['start', ['Bananas', 'Tin foil'], 'end']);
});

test('a refused microphone becomes something sayable, and still ends once', () => {
  const env = { SpeechRecognition: FakeRecognizer, isSecureContext: true };
  const calls = [];
  listenOnce({ onError: (m) => calls.push(m), onEnd: () => calls.push('end') }, env);
  FakeRecognizer.last.fail('not-allowed');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /refused/);
  assert.equal(calls[1], 'end');
});

test('stopping early is quiet: no error, just the end', () => {
  const env = { SpeechRecognition: FakeRecognizer, isSecureContext: true };
  const calls = [];
  const stop = listenOnce({ onError: (m) => calls.push(m), onEnd: () => calls.push('end') }, env);
  FakeRecognizer.last.onerror({ error: 'aborted' });
  stop();
  assert.deepEqual(calls, ['end']);
});

test('where voice cannot work, listening reports why without throwing', () => {
  const calls = [];
  listenOnce({ onError: (m) => calls.push(m), onEnd: () => calls.push('end') }, { isSecureContext: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 'end');
});
