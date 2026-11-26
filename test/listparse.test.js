import test from 'node:test';
import assert from 'node:assert/strict';

import { splitItems, MAX_ITEM_LENGTH } from '../public/js/listparse.js';

test('a typed list becomes separate items', () => {
  assert.deepEqual(splitItems('milk, eggs and bread'), ['Milk', 'Eggs', 'Bread']);
  assert.deepEqual(splitItems('milk; eggs; bread'), ['Milk', 'Eggs', 'Bread']);
  assert.deepEqual(splitItems('Milk & eggs'), ['Milk', 'Eggs']);
  assert.deepEqual(splitItems('apples and pears'), ['Apples', 'Pears']);
});

test('an Oxford comma does not leave an "and" on the last item', () => {
  assert.deepEqual(splitItems('milk, eggs, and bread'), ['Milk', 'Eggs', 'Bread']);
  assert.deepEqual(splitItems('milk, eggs, & bread'), ['Milk', 'Eggs', 'Bread']);
});

test('a pasted list is one item per line, bullets and numbers removed', () => {
  assert.deepEqual(splitItems('milk\neggs\r\nbread\n\n'), ['Milk', 'Eggs', 'Bread']);
  assert.deepEqual(splitItems('- milk\n* eggs\n• bread\n· jam'), ['Milk', 'Eggs', 'Bread', 'Jam']);
  assert.deepEqual(splitItems('1. milk\n2) eggs\n10. bread'), ['Milk', 'Eggs', 'Bread']);
  assert.deepEqual(splitItems('[ ] milk\n[x] eggs'), ['Milk', 'Eggs']);
});

test('lines and commas mix', () => {
  assert.deepEqual(splitItems('milk, eggs\nbread and baked beans\ntea'), [
    'Milk',
    'Eggs',
    'Bread',
    'Baked beans',
    'Tea',
  ]);
});

test('things with "and" in their name stay whole', () => {
  assert.deepEqual(splitItems('salt and vinegar crisps'), ['Salt and vinegar crisps']);
  assert.deepEqual(splitItems('mac & cheese, milk'), ['Mac and cheese', 'Milk']);
  assert.deepEqual(splitItems('fish and chips and peas'), ['Fish and chips', 'Peas']);
  assert.deepEqual(splitItems('Cheese and Onion crisps and dip'), ['Cheese and Onion crisps', 'Dip']);
  assert.deepEqual(splitItems('shampoo and conditioner'), ['Shampoo', 'Conditioner']);
});

test('"&" inside a word is part of it', () => {
  assert.deepEqual(splitItems('M&Ms and milk'), ['M&Ms', 'Milk']);
  assert.deepEqual(splitItems('Marks&Spencer voucher'), ['Marks&Spencer voucher']);
});

test('words that merely contain "and" are not split', () => {
  assert.deepEqual(splitItems('candles and sandwich bags, brandy'), ['Candles', 'Sandwich bags', 'Brandy']);
});

test('a single item is just that item', () => {
  assert.deepEqual(splitItems('Milk'), ['Milk']);
  assert.deepEqual(splitItems('  2 pints of milk.  '), ['2 pints of milk']);
});

test('capitalised only when written all in lower case', () => {
  assert.deepEqual(splitItems('iPad charger and AA batteries and soap'), ['iPad charger', 'AA batteries', 'Soap']);
});

test('repeats and empty pieces are dropped', () => {
  assert.deepEqual(splitItems('milk, Milk,, MILK and eggs, , and'), ['Milk', 'Eggs']);
  assert.deepEqual(splitItems(''), []);
  assert.deepEqual(splitItems(' , ; and '), []);
  assert.deepEqual(splitItems(null), []);
});

test('typed text keeps what it says; only speech loses its lead-in', () => {
  assert.deepEqual(splitItems('some apples'), ['Some apples']);
  assert.deepEqual(splitItems('Disney plus gift card'), ['Disney plus gift card']);
  assert.deepEqual(splitItems('add some apples plus pears', { spoken: true }), ['Apples', 'Pears']);
});

test('each item is clamped to what the store accepts', () => {
  const [long] = splitItems('x'.repeat(200));
  assert.equal(long.length, MAX_ITEM_LENGTH);
});
