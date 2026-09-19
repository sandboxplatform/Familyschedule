/**
 * Accounts.
 *
 * A household signs in with an email and a password rather than a shared
 * passcode, so an install starts by making the first account and everyone
 * after that is invited from inside.
 *
 * Passwords are stored as scrypt hashes with a per-account salt, in the format
 *   scrypt$N$r$p$<salt hex>$<hash hex>
 * so the cost parameters travel with the hash and can be raised later without
 * locking anybody out.
 */

import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const COST = { N: 16384, r: 8, p: 1, keyLength: 64 };
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const MAX_EMAIL = 254;

export class AccountError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AccountError';
    this.status = status;
  }
}

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Deliberately forgiving: this gate exists to catch a typo, not to adjudicate
 * RFC 5322. Anything with a local part, an @ and a dotted domain gets through.
 */
export function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value) && value.length <= MAX_EMAIL;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, COST.keyLength, {
    N: COST.N,
    r: COST.r,
    p: COST.p,
  });
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltHex, hashHex] = parts;
  let expected;
  try {
    expected = Buffer.from(hashHex, 'hex');
    const derived = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    // A malformed hash is not a match, and not a crash either.
    return false;
  }
}

export class Accounts {
  #db;

  constructor(db) {
    this.#db = db;
  }

  /** True before anybody has signed up — the state that opens the setup form. */
  get empty() {
    return !this.#db.prepare('SELECT 1 FROM users LIMIT 1').get();
  }

  get count() {
    return this.#db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  list() {
    return this.#db
      .prepare('SELECT id, email, created_at, last_seen_at FROM users ORDER BY created_at')
      .all()
      .map(present);
  }

  find(id) {
    const row = this.#db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? present(row) : null;
  }

  async create({ email, password }) {
    const address = normalizeEmail(email);
    if (!looksLikeEmail(address)) throw new AccountError('Enter a valid email address');

    const secret = typeof password === 'string' ? password : '';
    if (secret.length < MIN_PASSWORD) {
      throw new AccountError(`Password must be at least ${MIN_PASSWORD} characters`);
    }
    if (secret.length > MAX_PASSWORD) {
      throw new AccountError(`Password must be ${MAX_PASSWORD} characters or fewer`);
    }
    if (this.#db.prepare('SELECT 1 FROM users WHERE email_folded = ?').get(address)) {
      throw new AccountError('That email already has an account', 409);
    }

    const user = {
      id: randomUUID(),
      email: typeof email === 'string' ? email.trim() : address,
      created_at: new Date().toISOString(),
    };
    this.#db
      .prepare(
        `INSERT INTO users(id, email, email_folded, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(user.id, user.email, address, await hashPassword(secret), user.created_at);

    return present({ ...user, last_seen_at: null });
  }

  /**
   * Returns the account when the password matches, otherwise null. An unknown
   * email still pays for a hash comparison, so the reply takes the same time
   * whether or not the address exists.
   */
  async verify({ email, password }) {
    const address = normalizeEmail(email);
    const row = this.#db.prepare('SELECT * FROM users WHERE email_folded = ?').get(address);
    const stored = row ? row.password_hash : DUMMY_HASH;
    const ok = await verifyPassword(typeof password === 'string' ? password : '', stored);
    return ok && row ? present(row) : null;
  }

  touch(id) {
    this.#db
      .prepare('UPDATE users SET last_seen_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  async changePassword(id, password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      throw new AccountError(`Password must be at least ${MIN_PASSWORD} characters`);
    }
    const hash = await hashPassword(password);
    const result = this.#db
      .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(hash, id);
    if (!result.changes) throw new AccountError('No such account', 404);
  }

  delete(id) {
    if (this.count <= 1) {
      throw new AccountError('The last account cannot be removed — nobody could sign in', 409);
    }
    const result = this.#db.prepare('DELETE FROM users WHERE id = ?').run(id);
    if (!result.changes) throw new AccountError('No such account', 404);
  }
}

/* A real hash of a value nobody knows, so an unknown email costs the same
   scrypt work as a known one and cannot be picked out by timing. */
const DUMMY_HASH =
  'scrypt$16384$8$1$' +
  '00000000000000000000000000000000$' +
  '0'.repeat(128);

function present(row) {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? null,
  };
}
