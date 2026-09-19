/**
 * The HTTP layer: a small hand-rolled router over node:http.
 *
 * Zero runtime dependencies is a feature here — Hearth is meant to be dropped
 * on a Raspberry Pi or an old laptop in the utility room and forgotten about,
 * so `node server/index.js` has to be the whole install story.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { addDays, isDateKey, rangeKeys, todayKey } from './dates.js';
import { expandEvents, groupByDate } from './recurrence.js';
import { CATEGORIES, PALETTE, ValidationError, NotFoundError } from './store.js';
import { WeatherService, searchPlaces } from './weather.js';
import { clientId, createAuth, isSecureRequest } from './auth.js';
import { Accounts } from './accounts.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RANGE_DAYS = 400;
const HEARTBEAT_MS = 25000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function createApp(store, {
  weather = new WeatherService(),
  publicDir = PUBLIC_DIR,
  accounts = new Accounts(store.db),
  auth = createAuth({ db: store.db, accounts }),
  storage = { persistent: true, platform: null, path: null },
} = {}) {
  const clients = new Set();

  store.on('change', (change) => broadcast(clients, 'change', change));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (!isPublic(url.pathname) && !auth.isAuthenticated(req)) {
        denyUnauthenticated(req, res, url, auth);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, { store, weather, clients, auth, accounts, storage });
        return;
      }
      await serveStatic(req, res, url, publicDir);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error.status || 500;
      if (status >= 500) console.error('[hearth]', error);
      sendJson(res, status, { error: status >= 500 ? 'Something went wrong' : error.message });
    }
  });

  server.on('close', () => {
    for (const client of clients) client.end();
    clients.clear();
  });

  return server;
}

// -- API ------------------------------------------------------------------

/**
 * Paths that stay open to a signed-out visitor: the sign-in page and the assets
 * it needs, the session and account endpoints themselves, and the health probe
 * platforms poll. None of them expose calendar data — /api/account refuses on
 * its own once an account exists.
 */
function isPublic(pathname) {
  if (pathname === '/api/session' || pathname === '/api/account') return true;
  if (pathname === '/api/health') return true;
  if (pathname === '/login') return true;
  return /^\/(css|js|icons)\//.test(pathname) || pathname === '/manifest.webmanifest';
}

function denyUnauthenticated(req, res, url, auth) {
  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return;
  }
  const next = encodeURIComponent(url.pathname + url.search);
  const where = auth.setupRequired ? '/login?setup=1' : `/login?next=${next}`;
  res.writeHead(302, { Location: where, 'Cache-Control': 'no-store' });
  res.end();
}

async function handleApi(req, res, url, ctx) {
  const { store, weather, clients, auth, accounts, storage } = ctx;
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const segments = route ? route.split('/') : [];
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET, POST, PATCH, DELETE' });
    res.end();
    return;
  }

  // GET /api/bootstrap — everything a client needs to render its first frame.
  if (segments[0] === 'bootstrap' && method === 'GET') {
    const me = auth.currentUser(req);
    sendJson(res, 200, {
      settings: store.settings,
      members: store.members,
      categories: CATEGORIES,
      palette: PALETTE,
      user: me ? { id: me.id, email: me.email } : null,
      storage,
      today: todayKey(),
      serverTime: new Date().toISOString(),
    });
    return;
  }

  // GET /api/calendar?from=&to= — expanded occurrences grouped by day.
  if (segments[0] === 'calendar' && method === 'GET') {
    const from = isDateKey(url.searchParams.get('from')) ? url.searchParams.get('from') : todayKey();
    const requestedTo = url.searchParams.get('to');
    const to = isDateKey(requestedTo) && requestedTo >= from ? requestedTo : addDays(from, 13);
    const dates = rangeKeys(from, to).slice(0, MAX_RANGE_DAYS);
    const slices = expandEvents(store.events, dates[0], dates[dates.length - 1]);
    sendJson(res, 200, {
      from: dates[0],
      to: dates[dates.length - 1],
      today: todayKey(),
      serverTime: new Date().toISOString(),
      settings: store.settings,
      members: store.members,
      days: groupByDate(slices, dates),
    });
    return;
  }

  if (segments[0] === 'events') {
    if (segments.length === 1 && method === 'GET') {
      sendJson(res, 200, { events: store.events });
      return;
    }
    if (segments.length === 1 && method === 'POST') {
      const body = await readJson(req);
      sendJson(res, 201, { event: store.createEvent(body) });
      return;
    }
    if (segments.length === 2 && method === 'GET') {
      const event = store.events.find((e) => e.id === segments[1]);
      if (!event) throw new NotFoundError('Event not found');
      sendJson(res, 200, { event });
      return;
    }
    if (segments.length === 2 && (method === 'PATCH' || method === 'PUT')) {
      const body = await readJson(req);
      sendJson(res, 200, { event: store.updateEvent(segments[1], body) });
      return;
    }
    if (segments.length === 2 && method === 'DELETE') {
      store.deleteEvent(segments[1]);
      sendJson(res, 200, { ok: true });
      return;
    }
    // POST /api/events/:id/skip — drop one date from a repeating series.
    if (segments.length === 3 && segments[2] === 'skip' && method === 'POST') {
      const body = await readJson(req);
      const event = store.skipOccurrence(segments[1], body.date);
      sendJson(res, 200, { event: event || null });
      return;
    }
    // POST /api/events/:id/end — stop a series from a given date onwards.
    if (segments.length === 3 && segments[2] === 'end' && method === 'POST') {
      const body = await readJson(req);
      const event = store.endSeriesBefore(segments[1], body.date);
      sendJson(res, 200, { event: event || null });
      return;
    }
  }

  if (segments[0] === 'members') {
    if (segments.length === 1 && method === 'GET') {
      sendJson(res, 200, { members: store.members });
      return;
    }
    if (segments.length === 1 && method === 'POST') {
      const body = await readJson(req);
      sendJson(res, 201, { member: store.createMember(body) });
      return;
    }
    if (segments.length === 2 && (method === 'PATCH' || method === 'PUT')) {
      const body = await readJson(req);
      sendJson(res, 200, { member: store.updateMember(segments[1], body) });
      return;
    }
    if (segments.length === 2 && method === 'DELETE') {
      store.deleteMember(segments[1]);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (segments[0] === 'settings') {
    if (method === 'GET') {
      sendJson(res, 200, { settings: store.settings });
      return;
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJson(req);
      sendJson(res, 200, { settings: store.updateSettings(body) });
      return;
    }
  }

  // Looking a place up by name, so nobody has to know their own coordinates.
  if (segments[0] === 'places' && method === 'GET') {
    const results = await searchPlaces(url.searchParams.get('q') || '');
    sendJson(res, 200, { places: results });
    return;
  }

  if (segments[0] === 'weather' && method === 'GET') {
    const forecast = await weather.get(store.settings);
    sendJson(res, 200, { weather: forecast });
    return;
  }

  // GET /api/stream — server-sent events so the TV redraws the moment a phone
  // saves something. Polling would be simpler but visibly laggy in a kitchen.
  if (segments[0] === 'stream' && method === 'GET') {
    openStream(req, res, clients);
    return;
  }

  // Sessions: GET to ask where this install stands, POST to sign in, DELETE to
  // sign out.
  if (segments[0] === 'session') {
    if (method === 'GET') {
      const user = auth.currentUser(req);
      sendJson(res, 200, {
        setupRequired: auth.setupRequired,
        authenticated: Boolean(user),
        // So the sign-in page knows whether to offer signing up at all.
        canRegister: auth.setupRequired || store.settings.openRegistration,
        user: user ? { id: user.id, email: user.email } : null,
      });
      return;
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const result = await auth.attempt(
        { email: body.email, password: body.password },
        clientId(req),
      );
      if (!result.ok) {
        const status = result.retryAfterSeconds ? 429 : 401;
        const headers = result.retryAfterSeconds
          ? { 'Retry-After': String(result.retryAfterSeconds) }
          : undefined;
        sendJson(
          res,
          status,
          {
            error: result.retryAfterSeconds
              ? `Too many attempts — try again in ${Math.ceil(result.retryAfterSeconds / 60)} min`
              : 'That email and password do not match',
          },
          headers,
        );
        return;
      }
      res.setHeader('Set-Cookie', auth.cookie(result.user.id, { secure: isSecureRequest(req) }));
      sendJson(res, 200, { ok: true, user: { id: result.user.id, email: result.user.email } });
      return;
    }
    if (method === 'DELETE') {
      res.setHeader('Set-Cookie', auth.clearCookie({ secure: isSecureRequest(req) }));
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // Accounts. The first one is always open, because there is nobody to
  // authorise it. After that it depends on the household: open registration
  // lets anybody who has the address sign themselves up, and turning it off
  // means only somebody already signed in can add another.
  if (segments[0] === 'account' || segments[0] === 'accounts') {
    if (segments.length === 1 && method === 'POST') {
      const firstRun = auth.setupRequired;
      const open = store.settings.openRegistration;
      if (!firstRun && !open && !auth.isAuthenticated(req)) {
        sendJson(res, 403, {
          error: 'This calendar is invite-only — ask someone in the household to add you',
        });
        return;
      }
      const body = await readJson(req);
      const user = await accounts.create({ email: body.email, password: body.password });

      // Whoever sets the household up is signed in by the act of doing it.
      if (firstRun) {
        res.setHeader('Set-Cookie', auth.cookie(user.id, { secure: isSecureRequest(req) }));
      }
      sendJson(res, 201, { user, signedIn: firstRun });
      return;
    }

    if (segments.length === 1 && method === 'GET') {
      if (!auth.isAuthenticated(req)) {
        sendJson(res, 401, { error: 'Sign in to continue' });
        return;
      }
      sendJson(res, 200, { users: accounts.list() });
      return;
    }

    if (segments.length === 2 && method === 'DELETE') {
      const me = auth.currentUser(req);
      if (!me) {
        sendJson(res, 401, { error: 'Sign in to continue' });
        return;
      }
      accounts.delete(segments[1]);
      if (segments[1] === me.id) {
        res.setHeader('Set-Cookie', auth.clearCookie({ secure: isSecureRequest(req) }));
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (segments.length === 2 && segments[1] === 'password' && method === 'POST') {
      const me = auth.currentUser(req);
      if (!me) {
        sendJson(res, 401, { error: 'Sign in to continue' });
        return;
      }
      const body = await readJson(req);
      // Changing a password needs the current one, so a borrowed screen cannot
      // be used to lock its owner out.
      if (!(await accounts.verify({ email: me.email, password: body.current }))) {
        sendJson(res, 401, { error: 'Your current password is not right' });
        return;
      }
      await accounts.changePassword(me.id, body.password);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (segments[0] === 'health' && method === 'GET') {
    sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    return;
  }

  sendJson(res, 404, { error: 'Unknown endpoint' });
}

function openStream(req, res, clients) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref?.();

  clients.add(res);
  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(res);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

function broadcast(clients, event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

// -- static ---------------------------------------------------------------

const PAGES = new Map([
  ['/', 'index.html'],
  ['/tv', 'index.html'],
  ['/edit', 'edit.html'],
  ['/m', 'edit.html'],
  ['/login', 'login.html'],
]);

async function serveStatic(req, res, url, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const page = PAGES.get(url.pathname);
  const relative = page || decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const filePath = path.join(publicDir, relative);

  // Refuse anything that escapes the public directory.
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (stat.isDirectory()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    // HTML revalidates every load so a redeploy reaches the TV; hashed-free
    // assets get a short cache that still survives a flaky wifi moment.
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  await new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
}

// -- helpers --------------------------------------------------------------

export function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        const error = new ValidationError('Request body is too large');
        error.status = 413;
        reject(error);
        // Drain the rest instead of destroying the socket, so the client
        // actually receives the 413 rather than a connection reset.
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflowed) return;
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new ValidationError('Expected a JSON object'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new ValidationError('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
