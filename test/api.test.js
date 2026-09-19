import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { openDatabase } from '../server/db.js';
import { todayKey } from '../server/dates.js';

/**
 * Every route but the handful that let somebody sign in is behind an account,
 * so the harness makes one and carries its cookie. `call` is signed in;
 * `anonymous` deliberately is not, for the tests that check the gate.
 */
async function withServer(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-api-'));
  const store = new Store(openDatabase(path.join(dir, 'calendar.db')));
  await store.load();
  const server = createApp(store, { weather: { get: async () => null } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const anonymous = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, response };
  };

  const created = await anonymous('/api/account', {
    method: 'POST',
    body: { email: 'test@example.com', password: 'a-good-password' },
  });
  const cookie = created.response.headers.get('set-cookie').split(';')[0];

  const call = (path, options = {}) =>
    anonymous(path, { ...options, headers: { ...(options.headers || {}), Cookie: cookie } });

  try {
    await run({ call, anonymous, cookie, store, base });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  }
}

test('bootstrap describes the install', async () => {
  await withServer(async ({ call }) => {
    const { status, body } = await call('/api/bootstrap');
    assert.equal(status, 200);
    assert.equal(body.settings.familyName, 'Our Family');
    assert.ok(body.categories.includes('school'));
    assert.ok(body.palette.length >= 4);
    assert.equal(body.today, todayKey());
  });
});

test('events can be created, read, updated and deleted', async () => {
  await withServer(async ({ call }) => {
    const created = await call('/api/events', {
      method: 'POST',
      body: { title: 'Dentist', date: '2026-09-10', startTime: '09:00' },
    });
    assert.equal(created.status, 201);
    const id = created.body.event.id;

    const fetched = await call(`/api/events/${id}`);
    assert.equal(fetched.body.event.title, 'Dentist');

    const patched = await call(`/api/events/${id}`, {
      method: 'PATCH',
      body: { title: 'Dentist — Ava' },
    });
    assert.equal(patched.body.event.title, 'Dentist — Ava');
    assert.equal(patched.body.event.startTime, '09:00', 'untouched fields survive a patch');

    const removed = await call(`/api/events/${id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal((await call(`/api/events/${id}`)).status, 404);
  });
});

test('validation errors come back as 400 with a readable message', async () => {
  await withServer(async ({ call }) => {
    const missingTitle = await call('/api/events', { method: 'POST', body: { title: '', date: '2026-09-10' } });
    assert.equal(missingTitle.status, 400);
    assert.match(missingTitle.body.error, /title is required/);

    const badDate = await call('/api/events', { method: 'POST', body: { title: 'X', date: '2026-13-01' } });
    assert.equal(badDate.status, 400);
    assert.match(badDate.body.error, /date must be/);
  });
});

test('the calendar endpoint expands repeats into days', async () => {
  await withServer(async ({ call }) => {
    await call('/api/events', {
      method: 'POST',
      body: {
        title: 'Bin day',
        date: '2026-09-02',
        recurrence: { freq: 'weekly', interval: 1, byWeekday: [3] },
      },
    });

    const { body } = await call('/api/calendar?from=2026-09-01&to=2026-09-21');
    assert.equal(body.days.length, 21);
    const hits = body.days.filter((day) => day.items.length).map((day) => day.date);
    assert.deepEqual(hits, ['2026-09-02', '2026-09-09', '2026-09-16']);
    assert.equal(body.days[1].items[0].allDay, true);
    assert.equal(body.days[1].items[0].repeats, true);
  });
});

test('a bad range falls back to a two-week window instead of erroring', async () => {
  await withServer(async ({ call }) => {
    const { status, body } = await call('/api/calendar?from=nonsense&to=also-nonsense');
    assert.equal(status, 200);
    assert.equal(body.from, todayKey());
    assert.equal(body.days.length, 14);
  });
});

test('skip drops one date and end closes the series', async () => {
  await withServer(async ({ call }) => {
    const { body } = await call('/api/events', {
      method: 'POST',
      body: { title: 'Swim', date: '2026-09-01', recurrence: { freq: 'daily', interval: 1 } },
    });
    const id = body.event.id;

    await call(`/api/events/${id}/skip`, { method: 'POST', body: { date: '2026-09-02' } });
    await call(`/api/events/${id}/end`, { method: 'POST', body: { date: '2026-09-05' } });

    const calendar = await call('/api/calendar?from=2026-09-01&to=2026-09-10');
    const hits = calendar.body.days.filter((day) => day.items.length).map((day) => day.date);
    assert.deepEqual(hits, ['2026-09-01', '2026-09-03', '2026-09-04']);
  });
});

test('members and settings round-trip over HTTP', async () => {
  await withServer(async ({ call }) => {
    const created = await call('/api/members', { method: 'POST', body: { name: 'Mum', color: '#5b8def' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.member.initials, 'M');

    const duplicate = await call('/api/members', { method: 'POST', body: { name: 'mum' } });
    assert.equal(duplicate.status, 400);

    const settings = await call('/api/settings', {
      method: 'PATCH',
      body: { familyName: 'The Riveras', theme: 'daylight', defaultView: 'month', clock24h: true },
    });
    assert.equal(settings.body.settings.familyName, 'The Riveras');
    assert.equal(settings.body.settings.theme, 'daylight');
    assert.equal(settings.body.settings.defaultView, 'month');
    assert.equal(settings.body.settings.clock24h, true);
  });
});

test('looking up a place returns somewhere to put the weather', async (t) => {
  const { searchPlaces } = await import('../server/weather.js');

  const stub = async () => ({
    ok: true,
    json: async () => ({
      results: [
        {
          name: 'Leeds', admin1: 'England', country: 'United Kingdom',
          country_code: 'GB', latitude: 53.79648, longitude: -1.54785,
        },
        {
          name: 'Leeds', admin1: 'Alabama', country: 'United States',
          country_code: 'US', latitude: 33.54815, longitude: -86.5486,
        },
      ],
    }),
  });

  const found = await searchPlaces('Leeds', stub);
  assert.equal(found.length, 2);
  // Two places share the name, so the label has to say which is which.
  assert.equal(found[0].label, 'Leeds, England, United Kingdom');
  assert.equal(found[1].label, 'Leeds, Alabama, United States');
  assert.equal(found[0].latitude, 53.7965);

  // A search too short to mean anything never leaves the building.
  let called = false;
  await searchPlaces('L', async () => { called = true; });
  assert.equal(called, false);

  // Every way of failing is an empty list, never an error in someone's settings.
  assert.deepEqual(await searchPlaces('x', async () => ({ ok: false })), []);
  assert.deepEqual(await searchPlaces('x', async () => { throw new Error('offline'); }), []);
  assert.deepEqual(await searchPlaces('x', async () => ({ ok: true, json: async () => ({}) })), []);
});

test('the place endpoint is behind the sign-in like everything else', async () => {
  await withServer(async ({ anonymous, call }) => {
    assert.equal((await anonymous('/api/places?q=Leeds')).status, 401);
    // Signed in it answers, even where the lookup itself cannot be reached.
    assert.equal((await call('/api/places?q=')).status, 200);
  });
});

test('the stream pushes a frame when something changes', async () => {
  await withServer(async ({ base, store, cookie }) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, {
      signal: controller.signal,
      headers: { Cookie: cookie },
    });
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Drain the greeting, then make a change and expect it to arrive.
    await reader.read();
    store.createEvent({ title: 'Live update', date: '2026-09-10' });

    let received = '';
    while (!received.includes('event: change')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    assert.match(received, /event: change/);
    assert.match(received, /"scope":"events"/);
    controller.abort();
  });
});

test('static files are served and traversal is refused', async () => {
  await withServer(async ({ call, base }) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /Hearth/);

    const editor = await fetch(`${base}/edit`);
    assert.equal(editor.status, 200);

    const escaped = await fetch(`${base}/../package.json`, { redirect: 'manual' });
    assert.notEqual(escaped.status, 200);

    const missing = await call('/api/nope');
    assert.equal(missing.status, 404);
  });
});

test('oversized bodies are rejected', async () => {
  await withServer(async ({ call }) => {
    const { status } = await call('/api/events', {
      method: 'POST',
      body: { title: 'x'.repeat(300_000), date: '2026-09-10' },
    });
    assert.equal(status, 413);
  });
});
