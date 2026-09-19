import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Store, migrate, validateEvent, validateSettings, ValidationError } from '../server/store.js';
import { openDatabase } from '../server/db.js';
import { seedState } from '../server/seed.js';

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-'));
  const file = path.join(dir, 'calendar.db');
  const store = new Store(openDatabase(file));
  await store.load();
  return { store, dir, file };
}

test('a fresh store starts empty and creates its database', async () => {
  const { store, file } = await tempStore();
  assert.equal(store.events.length, 0);
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ['event_members', 'events', 'members', 'meta', 'settings', 'users']);
  await store.close();
  await fs.access(file);
});

test('events round-trip through the database', async () => {
  const { store, file } = await tempStore();
  const member = store.createMember({ name: 'Ava' });
  const created = store.createEvent({
    title: 'Piano',
    date: '2026-09-10',
    startTime: '16:00',
    endTime: '17:00',
    memberIds: [member.id],
    category: 'activity',
  });
  await store.close();

  const reopened = new Store(openDatabase(file));
  await reopened.load();
  assert.equal(reopened.events.length, 1);
  assert.equal(reopened.events[0].title, 'Piano');
  assert.deepEqual(reopened.events[0].memberIds, [created.memberIds[0]]);
});

test('rapid writes all land', async () => {
  const { store, file } = await tempStore();
  for (let i = 0; i < 25; i += 1) {
    store.createEvent({ title: `Event ${i}`, date: '2026-09-10' });
  }
  await store.close();

  const reopened = new Store(openDatabase(file));
  await reopened.load();
  assert.equal(reopened.events.length, 25);
  await reopened.close();
});

test('validation rejects nonsense', async () => {
  const { store } = await tempStore();
  assert.throws(() => store.createEvent({ title: '', date: '2026-09-10' }), ValidationError);
  assert.throws(() => store.createEvent({ title: 'X', date: '2026-02-30' }), ValidationError);
  assert.throws(() => store.createEvent({ title: 'X', date: '2026-09-10', startTime: '25:00' }), ValidationError);
  assert.throws(
    () => store.createEvent({ title: 'X', date: '2026-09-10', startTime: '10:00', endTime: '09:00' }),
    ValidationError,
  );
  assert.throws(
    () => store.createEvent({ title: 'X', date: '2026-09-10', endDate: '2026-09-01' }),
    ValidationError,
  );
});

test('unknown member ids are dropped rather than stored', async () => {
  const { store } = await tempStore();
  const event = store.createEvent({ title: 'X', date: '2026-09-10', memberIds: ['nope'] });
  assert.deepEqual(event.memberIds, []);
});

test('deleting a person untags their events', async () => {
  const { store } = await tempStore();
  const member = store.createMember({ name: 'Noah' });
  store.createEvent({ title: 'Swim', date: '2026-09-10', memberIds: [member.id] });
  store.deleteMember(member.id);
  assert.deepEqual(store.events[0].memberIds, []);
  assert.equal(store.members.length, 0);
});

test('duplicate names are refused so the TV legend stays readable', async () => {
  const { store } = await tempStore();
  store.createMember({ name: 'Ava' });
  assert.throws(() => store.createMember({ name: ' ava ' }), ValidationError);
});

test('skipping one occurrence keeps the rest of the series', async () => {
  const { store } = await tempStore();
  const event = store.createEvent({
    title: 'Swim',
    date: '2026-09-01',
    startTime: '17:00',
    recurrence: { freq: 'weekly', interval: 1, byWeekday: [2] },
  });
  store.skipOccurrence(event.id, '2026-09-08');
  assert.deepEqual(store.events[0].exceptions, ['2026-09-08']);
  assert.equal(store.events.length, 1);
});

test('skipping a one-off deletes it outright', async () => {
  const { store } = await tempStore();
  const event = store.createEvent({ title: 'Dentist', date: '2026-09-01' });
  store.skipOccurrence(event.id, '2026-09-01');
  assert.equal(store.events.length, 0);
});

test('ending a series sets until to the day before', async () => {
  const { store } = await tempStore();
  const event = store.createEvent({
    title: 'Swim',
    date: '2026-09-01',
    recurrence: { freq: 'weekly', interval: 1, byWeekday: [2] },
  });
  store.endSeriesBefore(event.id, '2026-09-15');
  assert.equal(store.events[0].recurrence.until, '2026-09-14');
});

test('ending a series at its first date removes it', async () => {
  const { store } = await tempStore();
  const event = store.createEvent({
    title: 'Swim',
    date: '2026-09-01',
    recurrence: { freq: 'daily', interval: 1 },
  });
  store.endSeriesBefore(event.id, '2026-09-01');
  assert.equal(store.events.length, 0);
});

test('settings are clamped to sane values', () => {
  const settings = validateSettings({
    familyName: '   ',
    weekStart: 7,
    theme: 'neon',
    defaultView: 'hologram',
    rotateSeconds: 9999,
    weather: { enabled: true, latitude: 300, longitude: -200, unit: 'kelvin' },
  });
  assert.equal(settings.familyName, 'Our Family');
  assert.equal(settings.weekStart, 1);
  assert.equal(settings.theme, 'midnight');
  assert.equal(settings.defaultView, 'agenda');
  // Absent means the default (open); anything present is read as a boolean.
  assert.equal(settings.openRegistration, true);
  assert.equal(validateSettings({ openRegistration: false }).openRegistration, false);
  assert.equal(validateSettings({ openRegistration: 'yes' }).openRegistration, true);
  assert.equal(settings.rotateSeconds, 600);
  assert.equal(settings.weather.latitude, 90);
  assert.equal(settings.weather.longitude, -180);
  assert.equal(settings.weather.unit, 'celsius');
});

test('every display view is accepted as the default', () => {
  for (const view of ['agenda', 'day', 'week', 'month']) {
    assert.equal(validateSettings({ defaultView: view }).defaultView, view);
  }
});

test('migration keeps good rows and drops broken ones', () => {
  const state = migrate({
    settings: { familyName: 'Test' },
    members: [{ name: 'Ava' }, { name: '' }],
    events: [
      { title: 'Good', date: '2026-09-10' },
      { title: 'Bad', date: 'not-a-date' },
      null,
    ],
  });
  assert.equal(state.members.length, 1);
  assert.equal(state.events.length, 1);
  assert.equal(state.settings.familyName, 'Test');
});

test('the seed looks like a real week', () => {
  const state = seedState('2026-09-18');
  assert.equal(state.members.length, 4);
  assert.ok(state.events.length >= 8);
  assert.ok(state.events.every((event) => validateEvent(event, state.members)));
});

test('change events fire for every mutation', async () => {
  const { store } = await tempStore();
  const scopes = [];
  store.on('change', (change) => scopes.push(change.scope));
  const member = store.createMember({ name: 'Ava' });
  store.updateMember(member.id, { name: 'Ava B' });
  const event = store.createEvent({ title: 'X', date: '2026-09-10' });
  store.updateEvent(event.id, { title: 'Y' });
  store.deleteEvent(event.id);
  store.updateSettings({ familyName: 'Hearth House' });
  await store.close();
  assert.deepEqual(scopes, ['members', 'members', 'events', 'events', 'events', 'settings']);
});
