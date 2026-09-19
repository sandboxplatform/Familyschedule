/**
 * The access gate.
 *
 * Everything is behind an account: there is no anonymous mode, because the one
 * that used to exist was a shared passcode in an environment variable and an
 * install with it unset was wide open to anyone who found the address.
 *
 * Sessions are a signed cookie carrying the account id — no session table to
 * clean up, and a cookie that survives a restart, which matters for a screen on
 * a wall that nobody wants to sign in again every time the box reboots. The
 * signing key lives in the database, so it persists without a key file, and
 * rotating it signs everybody out.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { readMeta, writeMeta } from './db.js';

export const SESSION_COOKIE = 'hearth_session';

const DEFAULT_MAX_AGE_DAYS = 365;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

/** The signing key, made on first run and kept in the database thereafter. */
export function sessionSecret(db) {
  const existing = readMeta(db, 'session_secret');
  if (existing) return Buffer.from(existing, 'hex');
  const secret = randomBytes(32);
  writeMeta(db, 'session_secret', secret.toString('hex'));
  return secret;
}

export function createAuth({ db, accounts, maxAgeDays = DEFAULT_MAX_AGE_DAYS, now = () => Date.now() }) {
  const secret = sessionSecret(db);
  const maxAgeMs = maxAgeDays * 86400000;
  const attempts = new Map();

  const sign = (payload) => createHmac('sha256', secret).update(payload).digest('hex');

  return {
    /** True until the first account exists, which is what opens the setup form. */
    get setupRequired() {
      return accounts.empty;
    },

    /** The signed-in account for this request, or null. */
    currentUser(req) {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      if (!token) return null;

      const [userId, issuedAt, signature] = token.split('.');
      if (!userId || !issuedAt || !signature) return null;

      const age = now() - Number(issuedAt);
      if (!Number.isFinite(age) || age < -60000 || age > maxAgeMs) return null;
      if (!safeEqual(signature, sign(`${userId}.${issuedAt}`))) return null;

      // A cookie outliving the account it names is not a session.
      return accounts.find(userId);
    },

    isAuthenticated(req) {
      return Boolean(this.currentUser(req));
    },

    /**
     * Checks an email and password. Attempts are capped per client so a weak
     * password cannot simply be walked through by a script.
     */
    async attempt({ email, password }, clientId = 'unknown') {
      const record = attempts.get(clientId);
      const at = now();
      if (record && at < record.resetAt && record.count >= MAX_ATTEMPTS) {
        return { ok: false, retryAfterSeconds: Math.ceil((record.resetAt - at) / 1000) };
      }

      const user = await accounts.verify({ email, password });
      if (user) {
        attempts.delete(clientId);
        accounts.touch(user.id);
        return { ok: true, user };
      }

      const next =
        record && at < record.resetAt
          ? { count: record.count + 1, resetAt: record.resetAt }
          : { count: 1, resetAt: at + ATTEMPT_WINDOW_MS };
      attempts.set(clientId, next);

      if (next.count >= MAX_ATTEMPTS) {
        return { ok: false, retryAfterSeconds: Math.ceil((next.resetAt - at) / 1000) };
      }
      return { ok: false };
    },

    cookie(userId, { secure }) {
      const issuedAt = now();
      const value = `${userId}.${issuedAt}.${sign(`${userId}.${issuedAt}`)}`;
      return serializeCookie(value, { maxAge: Math.floor(maxAgeMs / 1000), secure });
    },

    clearCookie({ secure }) {
      return serializeCookie('', { maxAge: 0, secure });
    },
  };
}

function serializeCookie(value, { maxAge, secure }) {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Behind a platform proxy the socket address is the proxy, not the client. */
export function clientId(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/** True when the original request reached the proxy over TLS. */
export function isSecureRequest(req) {
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto) return proto.split(',')[0].trim() === 'https';
  return Boolean(req.socket?.encrypted);
}
