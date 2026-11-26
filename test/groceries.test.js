import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.js';
import { Store, ValidationError, NotFoundError, GROCERY_NAME_MAX, migrate } from '../server/store.js';
import { openDatabase } from '../server/db.js';
import { MAX_ITEM_LENGTH } from '../public/js/speech.js';

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-groceries-'));
  const file = path.join(dir, 'calendar.db');
  const store = new Store(openDatabase(file));
  await store.load();
  return { store, file };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// -- the store --------------------------------------------------------------

test('items are added, listed and survive a restart', async () => {
  const { store, file } = await tempStore();
  const { item, duplicate, revived } = store.addGroceryItem({ name: '  Milk ', note: '2 pints' });
  assert.equal(item.name, 'Milk');
  assert.equal(item.note, '2 pints');
  assert.equal(item.checked, false);
  assert.equal(duplicate, false);
  assert.equal(revived, false);
  await store.close();

  const reopened = new Store(openDatabase(file));
  await reopened.load();
  assert.deepEqual(reopened.groceries.map((g) => g.name), ['Milk']);
  await reopened.close();
});

test('adding a name already on the list returns that row instead of a second', async () => {
  const { store } = await tempStore();
  const first = store.addGroceryItem({ name: 'Coffee beans' });
  const again = store.addGroceryItem({ name: 'coffee  BEANS' });
  assert.equal(again.duplicate, true);
  assert.equal(again.revived, false);
  assert.equal(again.item.id, first.item.id);
  assert.equal(store.groceries.length, 1);
});

test('asking again for something already ticked puts it back on the list', async () => {
  const { store } = await tempStore();
  const { item } = store.addGroceryItem({ name: 'Eggs' });
  store.updateGroceryItem(item.id, { checked: true });
  const again = store.addGroceryItem({ name: 'eggs' });
  assert.equal(again.duplicate, true);
  assert.equal(again.revived, true);
  assert.equal(again.item.checked, false);
  assert.equal(again.item.checkedAt, null);
  assert.equal(store.groceries.length, 1);
});

test('ticking stamps when, unticking clears it, and editing a ticked row keeps the stamp', async () => {
  const { store } = await tempStore();
  const { item } = store.addGroceryItem({ name: 'Bread' });

  const ticked = store.updateGroceryItem(item.id, { checked: true });
  assert.equal(ticked.checked, true);
  assert.ok(ticked.checkedAt);

  await tick();
  const renamed = store.updateGroceryItem(item.id, { name: 'Sourdough', note: 'sliced' });
  assert.equal(renamed.checkedAt, ticked.checkedAt, 'an edit must not reshuffle the picked list');
  assert.equal(renamed.checked, true);

  await tick();
  const reticked = store.updateGroceryItem(item.id, { checked: true });
  assert.equal(reticked.checkedAt, ticked.checkedAt, 'ticking twice is not a new tick');

  const unticked = store.updateGroceryItem(item.id, { checked: false });
  assert.equal(unticked.checked, false);
  assert.equal(unticked.checkedAt, null);
});

test('a client cannot set the stamp itself', async () => {
  const { store } = await tempStore();
  const { item } = store.addGroceryItem({ name: 'Tea', checked: true, checkedAt: '2000-01-01T00:00:00Z' });
  assert.equal(item.checked, false, 'a new item always starts on the list');
  const ticked = store.updateGroceryItem(item.id, { checked: true, checkedAt: '2000-01-01T00:00:00Z' });
  assert.notEqual(ticked.checkedAt, '2000-01-01T00:00:00Z');
});

test('renaming onto a name already on the list is refused', async () => {
  const { store } = await tempStore();
  store.addGroceryItem({ name: 'Milk' });
  const { item } = store.addGroceryItem({ name: 'Oat milk' });
  assert.throws(() => store.updateGroceryItem(item.id, { name: 'MILK' }), ValidationError);
});

test('validation refuses blank and over-long names', async () => {
  const { store } = await tempStore();
  assert.throws(() => store.addGroceryItem({ name: '   ' }), ValidationError);
  assert.throws(() => store.addGroceryItem({ name: 'x'.repeat(GROCERY_NAME_MAX + 1) }), ValidationError);
  assert.ok(store.addGroceryItem({ name: 'x'.repeat(GROCERY_NAME_MAX) }).item);
  assert.throws(() => store.updateGroceryItem('nope', { checked: true }), NotFoundError);
  assert.throws(() => store.deleteGroceryItem('nope'), NotFoundError);
});

test('voice input clamps items to what the store accepts', () => {
  assert.equal(MAX_ITEM_LENGTH, GROCERY_NAME_MAX);
});

test('clearing picked items removes only those', async () => {
  const { store, file } = await tempStore();
  const a = store.addGroceryItem({ name: 'Apples' }).item;
  store.addGroceryItem({ name: 'Bananas' });
  const c = store.addGroceryItem({ name: 'Cheese' }).item;
  store.updateGroceryItem(a.id, { checked: true });
  store.updateGroceryItem(c.id, { checked: true });

  assert.equal(store.clearPickedGroceries(), 2);
  assert.deepEqual(store.groceries.map((g) => g.name), ['Bananas']);
  assert.equal(store.clearPickedGroceries(), 0);
  await store.close();

  const reopened = new Store(openDatabase(file));
  await reopened.load();
  assert.deepEqual(reopened.groceries.map((g) => g.name), ['Bananas']);
  await reopened.close();
});

test('deleting a person keeps what they asked for, unattributed', async () => {
  const { store, file } = await tempStore();
  const ava = store.createMember({ name: 'Ava' });
  const { item } = store.addGroceryItem({ name: 'Crisps', addedBy: ava.id });
  assert.equal(item.addedBy, ava.id);
  store.deleteMember(ava.id);
  assert.equal(store.groceries[0].addedBy, null);
  await store.close();

  const reopened = new Store(openDatabase(file));
  await reopened.load();
  assert.equal(reopened.groceries[0].addedBy, null);
  assert.equal(reopened.groceries[0].name, 'Crisps');
  await reopened.close();
});

test('an unknown person is not recorded as having added something', async () => {
  const { store } = await tempStore();
  const { item } = store.addGroceryItem({ name: 'Jam', addedBy: 'nobody' });
  assert.equal(item.addedBy, null);
});

test('every change to the list is announced with its own scope', async () => {
  const { store } = await tempStore();
  const scopes = [];
  store.on('change', (change) => scopes.push(change.scope));
  const { item } = store.addGroceryItem({ name: 'Rice' });
  store.addGroceryItem({ name: 'rice' }); // a plain duplicate changes nothing
  store.updateGroceryItem(item.id, { checked: true });
  store.clearPickedGroceries();
  store.addGroceryItem({ name: 'Pasta' });
  store.deleteGroceryItem(store.groceries[0].id);
  assert.deepEqual(scopes, ['groceries', 'groceries', 'groceries', 'groceries', 'groceries']);
});

test('migration keeps good rows, drops broken ones and folds repeats', () => {
  const state = migrate({
    groceries: [{ name: 'Milk' }, { name: '' }, { name: 'milk' }, null, { name: 'Eggs', checked: true }],
  });
  assert.deepEqual(state.groceries.map((g) => g.name), ['Milk', 'Eggs']);
  assert.equal(state.groceries[1].checked, true);
});

test('a database from before the list gains the table when it opens', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-old-'));
  const file = path.join(dir, 'calendar.db');
  const db = openDatabase(file);
  db.exec('DROP TABLE groceries');
  db.close();

  const store = new Store(openDatabase(file));
  await store.load();
  assert.deepEqual(store.groceries, []);
  assert.ok(store.addGroceryItem({ name: 'Milk' }).item);
  await store.close();
});

// -- over HTTP --------------------------------------------------------------

async function withServer(run) {
  const { store } = await tempStore();
  const server = createApp(store, { weather: { get: async () => null } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const anonymous = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const created = await fetch(`${base}/api/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'shop@example.com', password: 'a-good-password' }),
  });
  const cookie = created.headers.get('set-cookie').split(';')[0];
  const call = (route, options = {}) =>
    anonymous(route, { ...options, headers: { ...(options.headers || {}), Cookie: cookie } });

  try {
    await run({ call, anonymous, store, base, cookie });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  }
}

test('the list can be added to, ticked, edited, cleared and emptied over HTTP', async () => {
  await withServer(async ({ call }) => {
    const added = await call('/api/groceries', { method: 'POST', body: { name: 'Bananas' } });
    assert.equal(added.status, 201);
    assert.equal(added.body.duplicate, false);
    assert.equal(added.body.revived, false);
    const id = added.body.item.id;

    const again = await call('/api/groceries', { method: 'POST', body: { name: 'bananas' } });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.item.id, id);

    const ticked = await call(`/api/groceries/${id}`, { method: 'PATCH', body: { checked: true } });
    assert.equal(ticked.status, 200);
    assert.equal(ticked.body.item.checked, true);
    assert.ok(ticked.body.item.checkedAt);

    const revived = await call('/api/groceries', { method: 'POST', body: { name: 'Bananas' } });
    assert.equal(revived.body.revived, true);
    assert.equal(revived.body.item.checked, false);

    await call(`/api/groceries/${id}`, { method: 'PATCH', body: { checked: true } });
    await call('/api/groceries', { method: 'POST', body: { name: 'Tin foil' } });

    const listed = await call('/api/groceries');
    assert.deepEqual(listed.body.groceries.map((g) => g.name), ['Bananas', 'Tin foil']);

    const cleared = await call('/api/groceries', { method: 'DELETE' });
    assert.equal(cleared.body.removed, 1);

    const foil = (await call('/api/groceries')).body.groceries[0];
    assert.equal(foil.name, 'Tin foil');
    assert.equal((await call(`/api/groceries/${foil.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await call(`/api/groceries/${foil.id}`, { method: 'DELETE' })).status, 404);
    assert.deepEqual((await call('/api/groceries')).body.groceries, []);
  });
});

test('bad input is a 400, not a broken list', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('/api/groceries', { method: 'POST', body: { name: '' } })).status, 400);
    assert.equal(
      (await call('/api/groceries/missing', { method: 'PATCH', body: { checked: true } })).status,
      404,
    );
  });
});

test('the calendar the TV fetches carries the list with it', async () => {
  await withServer(async ({ call }) => {
    await call('/api/groceries', { method: 'POST', body: { name: 'Coffee' } });
    const { body } = await call('/api/calendar');
    assert.deepEqual(body.groceries.map((g) => g.name), ['Coffee']);
  });
});

test('a change to the list reaches every screen on the live stream', async () => {
  await withServer(async ({ call, base, cookie }) => {
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/stream`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    const read = (async () => {
      while (!seen.includes('"scope":"groceries"')) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value);
      }
    })();

    await call('/api/groceries', { method: 'POST', body: { name: 'Butter' } });
    await Promise.race([read, new Promise((resolve) => setTimeout(resolve, 2000))]);
    controller.abort();
    assert.match(seen, /event: change\ndata: \{"scope":"groceries"/);
  });
});

test('the list is closed to anybody not signed in', async () => {
  await withServer(async ({ anonymous }) => {
    assert.equal((await anonymous('/api/groceries')).status, 401);
    assert.equal((await anonymous('/api/groceries', { method: 'POST', body: { name: 'Milk' } })).status, 401);
    assert.equal((await anonymous('/api/groceries', { method: 'DELETE' })).status, 401);
    assert.equal(
      (await anonymous('/api/groceries/x', { method: 'PATCH', body: { checked: true } })).status,
      401,
    );
  });
});

test('clearing everything empties the list, ticked or not', async () => {
  const { store, file } = await tempStore();
  const a = store.addGroceryItem({ name: 'Apples' }).item;
  store.addGroceryItem({ name: 'Bananas' });
  store.updateGroceryItem(a.id, { checked: true });
  assert.equal(store.clearAllGroceries(), 2);
  assert.deepEqual(store.groceries, []);
  assert.equal(store.clearAllGroceries(), 0);
  await store.close();

  const reopened = new Store(openDatabase(file));
  await reopened.load();
  assert.deepEqual(reopened.groceries, []);
  await reopened.close();
});

test('over HTTP, ?all=1 clears everything and plain DELETE only the ticked', async () => {
  await withServer(async ({ call, anonymous }) => {
    const milk = (await call('/api/groceries', { method: 'POST', body: { name: 'Milk' } })).body.item;
    await call('/api/groceries', { method: 'POST', body: { name: 'Eggs' } });
    await call(`/api/groceries/${milk.id}`, { method: 'PATCH', body: { checked: true } });

    assert.equal((await call('/api/groceries', { method: 'DELETE' })).body.removed, 1);
    assert.deepEqual((await call('/api/groceries')).body.groceries.map((g) => g.name), ['Eggs']);

    assert.equal((await anonymous('/api/groceries?all=1', { method: 'DELETE' })).status, 401);
    assert.equal((await call('/api/groceries?all=1', { method: 'DELETE' })).body.removed, 1);
    assert.deepEqual((await call('/api/groceries')).body.groceries, []);
  });
});
