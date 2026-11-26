import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSpokenItems, voiceSupport, listenForList, MAX_ITEM_LENGTH } from '../public/js/speech.js';

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
    if (this.stopped) return;
    this.stopped = true;
    this.onend?.();
  }
  /** Results as [transcript, isFinal] pairs, the way a continuous recogniser reports them. */
  hear(results, resultIndex = 0) {
    const list = results.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal }));
    this.onresult?.({ results: list, resultIndex });
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

test('a list said with pauses becomes one item per pause, and the mic keeps listening', async () => {
  const env = { SpeechRecognition: FakeRecognizer, isSecureContext: true, navigator: { language: 'en-GB' } };
  const updates = [];
  let done = null;
  listenForList(
    {
      onUpdate: (items) => updates.push(items),
      onDone: (items) => {
        done = items;
      },
    },
    env,
  );
  const recognizer = FakeRecognizer.last;
  assert.equal(recognizer.continuous, true, 'must not stop at the first pause');
  assert.equal(recognizer.interimResults, true);

  recognizer.hear([['milk', true]]);
  recognizer.hear([['milk', true], ['coffee', false]]);
  recognizer.hear([['milk', true], ['coffee beans', true]], 1);
  recognizer.hear([['milk', true], ['coffee beans', true], ['tin foil', true]], 2);
  recognizer.stop();

  assert.deepEqual(updates[0], ['Milk']);
  assert.deepEqual(updates[1], ['Milk', 'Coffee'], 'interim words show as they come');
  assert.deepEqual(done, ['Milk', 'Coffee beans', 'Tin foil']);
});

test('a run said without pauses is split into the items it is made of', () => {
  const env = { SpeechRecognition: FakeRecognizer, isSecureContext: true };
  let done = null;
  listenForList({ onDone: (items) => { done = items; } }, env);
  FakeRecognizer.last.hear([['add milk eggs bread coffee beans and tin foil', true]]);
  FakeRecognizer.last.stop();
  assert.deepEqual(done, ['Milk', 'Eggs', 'Bread', 'Coffee beans', 'Tin foil']);
});

test('a recogniser that repeats the whole transcript as each final is not doubled', () => {
  const env = { SpeechRecognition: FakeRecognizer, isSecureContext: true };
  let done = null;
  listenForList({ onDone: (items) => { done = items; } }, env);
  const r = FakeRecognizer.last;
  r.hear([['milk', true]]);
  r.hear([['milk', true], ['milk eggs', true]], 1);
  r.hear([['milk', true], ['milk eggs', true], ['milk eggs bread', true]], 2);
  r.stop();
  assert.deepEqual(done, ['Milk', 'Eggs', 'Bread']);
});

test('a pause long enough after speaking stops listening by itself', async () => {
  const env = { SpeechRecognition: FakeRecognizer, isSecureContext: true };
  let ended = false;
  listenForList({ silenceMs: 30, onEnd: () => { ended = true; } }, env);
  const r = FakeRecognizer.last;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(r.stopped, false, 'silence before anything is said is left to the recogniser');
  r.hear([['milk', true]]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(r.stopped, true);
  assert.equal(ended, true);
});

test('a refused microphone becomes something sayable, and still ends once', () => {
  const env = { SpeechRecognition: FakeRecognizer, isSecureContext: true };
  const calls = [];
  listenForList({ onError: (m) => calls.push(m), onEnd: () => calls.push('end') }, env);
  FakeRecognizer.last.fail('not-allowed');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /refused/);
  assert.equal(calls[1], 'end');
});

test('stopping early is quiet: no error, just the end', () => {
  const env = { SpeechRecognition: FakeRecognizer, isSecureContext: true };
  const calls = [];
  const stop = listenForList({ onError: (m) => calls.push(m), onEnd: () => calls.push('end') }, env);
  FakeRecognizer.last.onerror({ error: 'aborted' });
  stop();
  assert.deepEqual(calls, ['end']);
});

test('where voice cannot work, listening reports why without throwing', () => {
  const calls = [];
  listenForList({ onError: (m) => calls.push(m), onEnd: () => calls.push('end') }, { isSecureContext: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 'end');
});
