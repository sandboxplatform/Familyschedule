import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { openDatabase } from '../server/db.js';
import { Accounts, hashPassword, verifyPassword } from '../server/accounts.js';
import { createAuth, readCookie, SESSION_COOKIE } from '../server/auth.js';

const PASSWORD = 'a-good-password';

async function withServer(run, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hearth-auth-'));
  const db = openDatabase(path.join(dir, 'calendar.db'));
  const store = new Store(db);
  await store.load();
  const accounts = new Accounts(db);
  const server = createApp(store, {
    weather: { get: async () => null },
    accounts,
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (p, options = {}) => {
    const response = await fetch(`${base}${p}`, {
      ...options,
      redirect: 'manual',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body, response };
  };

  const signUp = async (email = 'first@example.com', password = PASSWORD) => {
    const created = await call('/api/account', { method: 'POST', body: { email, password } });
    return { created, cookie: created.response.headers.get('set-cookie')?.split(';')[0] };
  };

  try {
    await run({ call, signUp, store, accounts, db, base });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('a fresh install asks to be set up, and refuses everything else', async () => {
  await withServer(async ({ call }) => {
    const session = await call('/api/session');
    assert.equal(session.body.setupRequired, true);
    assert.equal(session.body.authenticated, false);

    assert.equal((await call('/api/calendar')).status, 401);
    assert.equal((await call('/api/events')).status, 401);
    assert.equal((await call('/api/bootstrap')).status, 401);

    // Health stays open so a platform can probe an unclaimed install.
    assert.equal((await call('/api/health')).status, 200);
  });
});

test('the first account is created without signing in, and signs you in', async () => {
  await withServer(async ({ call, signUp }) => {
    const { created, cookie } = await signUp();
    assert.equal(created.status, 201);
    assert.equal(created.body.signedIn, true);
    assert.ok(cookie, 'expected a session cookie');

    assert.equal((await call('/api/calendar', { headers: { Cookie: cookie } })).status, 200);

    const session = await call('/api/session', { headers: { Cookie: cookie } });
    assert.equal(session.body.setupRequired, false);
    assert.equal(session.body.authenticated, true);
    assert.equal(session.body.user.email, 'first@example.com');
  });
});

test('a second account cannot be created by a stranger', async () => {
  await withServer(async ({ call, signUp }) => {
    const { cookie } = await signUp();

    const uninvited = await call('/api/account', {
      method: 'POST',
      body: { email: 'stranger@example.com', password: PASSWORD },
    });
    assert.equal(uninvited.status, 401);

    const invited = await call('/api/account', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: { email: 'second@example.com', password: PASSWORD },
    });
    assert.equal(invited.status, 201);
    // Adding somebody does not sign the new person in on this device.
    assert.equal(invited.body.signedIn, false);
  });
});

test('signing in is case-insensitive about the email but not the password', async () => {
  await withServer(async ({ call, signUp }) => {
    await signUp('Someone@Example.com');

    const right = await call('/api/session', {
      method: 'POST',
      body: { email: 'SOMEONE@example.COM', password: PASSWORD },
    });
    assert.equal(right.status, 200);
    assert.ok(readCookie(right.response.headers.get('set-cookie'), SESSION_COOKIE));

    const wrong = await call('/api/session', {
      method: 'POST',
      body: { email: 'someone@example.com', password: PASSWORD.toUpperCase() },
    });
    assert.equal(wrong.status, 401);
  });
});

test('a wrong password and an unknown email are not told apart', async () => {
  await withServer(async ({ call, signUp }) => {
    await signUp();
    const wrongPassword = await call('/api/session', {
      method: 'POST',
      body: { email: 'first@example.com', password: 'not-the-password' },
    });
    const unknownEmail = await call('/api/session', {
      method: 'POST',
      body: { email: 'nobody@example.com', password: 'not-the-password' },
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.equal(wrongPassword.body.error, unknownEmail.body.error);
  });
});

test('guessing is throttled', async () => {
  await withServer(async ({ call, signUp }) => {
    await signUp();
    let last;
    for (let i = 0; i < 9; i += 1) {
      last = await call('/api/session', {
        method: 'POST',
        body: { email: 'first@example.com', password: `guess-${i}` },
      });
    }
    assert.equal(last.status, 429);
    assert.ok(last.response.headers.get('retry-after'));

    // Even the correct password is refused while the lockout stands.
    const correct = await call('/api/session', {
      method: 'POST',
      body: { email: 'first@example.com', password: PASSWORD },
    });
    assert.equal(correct.status, 429);
  });
});

test('signing out invalidates the cookie', async () => {
  await withServer(async ({ call, signUp }) => {
    const { cookie } = await signUp();
    assert.equal((await call('/api/calendar', { headers: { Cookie: cookie } })).status, 200);

    const out = await call('/api/session', { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(out.status, 200);
    const cleared = out.response.headers.get('set-cookie');
    assert.match(cleared, /Max-Age=0/);
  });
});

test('a tampered cookie is not a session', async () => {
  await withServer(async ({ call, signUp }) => {
    const { cookie } = await signUp();
    const [name, value] = cookie.split('=');
    const [userId, issuedAt, signature] = value.split('.');

    const forged = `${name}=${userId}.${issuedAt}.${'0'.repeat(signature.length)}`;
    assert.equal((await call('/api/calendar', { headers: { Cookie: forged } })).status, 401);

    const swapped = `${name}=00000000-0000-0000-0000-000000000000.${issuedAt}.${signature}`;
    assert.equal((await call('/api/calendar', { headers: { Cookie: swapped } })).status, 401);
  });
});

test('a signed-out browser is sent to the sign-in page, not the calendar', async () => {
  await withServer(async ({ call }) => {
    const page = await call('/edit');
    assert.equal(page.status, 302);
    // Nothing is set up yet, so it asks for setup rather than a sign-in.
    assert.match(page.response.headers.get('location'), /^\/login\?setup=1$/);
  });
});

test('the sign-in page and its assets stay reachable', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('/login')).status, 200);
    assert.equal((await call('/css/base.css')).status, 200);
    assert.equal((await call('/js/login.js')).status, 200);
  });
});

test('sessions expire, and rotating the signing key ends them', async () => {
  await withServer(async ({ db, accounts }) => {
    const user = await accounts.create({ email: 'clock@example.com', password: PASSWORD });
    const req = (cookie) => ({ headers: { cookie } });

    const fresh = createAuth({ db, accounts, maxAgeDays: 1, now: () => 0 });
    const cookie = fresh.cookie(user.id, { secure: false }).split(';')[0];
    assert.equal(fresh.currentUser(req(cookie))?.id, user.id);

    const later = createAuth({ db, accounts, maxAgeDays: 1, now: () => 2 * 86400000 });
    assert.equal(later.currentUser(req(cookie)), null);

    // A new signing key makes every cookie issued under the old one worthless.
    db.prepare('DELETE FROM meta WHERE key = ?').run('session_secret');
    const rotated = createAuth({ db, accounts, now: () => 0 });
    assert.equal(rotated.currentUser(req(cookie)), null);
  });
});

test('a cookie outliving its account is not a session', async () => {
  await withServer(async ({ call, signUp, accounts }) => {
    const { cookie } = await signUp();
    await accounts.create({ email: 'second@example.com', password: PASSWORD });

    const me = accounts.list().find((u) => u.email === 'first@example.com');
    accounts.delete(me.id);

    assert.equal((await call('/api/calendar', { headers: { Cookie: cookie } })).status, 401);
  });
});

test('the last account cannot be deleted', async () => {
  await withServer(async ({ signUp, accounts }) => {
    await signUp();
    const [only] = accounts.list();
    assert.throws(() => accounts.delete(only.id), /last account/);
  });
});

test('password hashes are salted, and verify only against their own password', async () => {
  const a = await hashPassword(PASSWORD);
  const b = await hashPassword(PASSWORD);
  assert.notEqual(a, b, 'the same password must not produce the same hash twice');
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);

  assert.equal(await verifyPassword(PASSWORD, a), true);
  assert.equal(await verifyPassword(PASSWORD, b), true);
  assert.equal(await verifyPassword('something-else', a), false);
  assert.equal(await verifyPassword(PASSWORD, 'not-a-hash'), false);
  assert.equal(await verifyPassword(PASSWORD, ''), false);
});

test('accounts are validated before they are stored', async () => {
  await withServer(async ({ accounts }) => {
    await assert.rejects(() => accounts.create({ email: 'nope', password: PASSWORD }), /valid email/);
    await assert.rejects(
      () => accounts.create({ email: 'a@b.com', password: 'short' }),
      /at least 8/,
    );
    await accounts.create({ email: 'a@b.com', password: PASSWORD });
    await assert.rejects(
      () => accounts.create({ email: 'A@B.COM', password: PASSWORD }),
      /already has an account/,
    );
  });
});
