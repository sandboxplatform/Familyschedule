#!/usr/bin/env node
/**
 * Entry point. Reads configuration from the environment, opens the store and
 * starts listening — then prints the two URLs a household actually needs:
 * one for the TV, one for the phone in their pocket.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { Store } from './store.js';
import { openDatabase } from './db.js';
import { Accounts } from './accounts.js';
import { seedState } from './seed.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const port = Number(process.env.PORT || 4321);

/*
 * Binding 0.0.0.0 listens on IPv4 only, and browsers resolve "localhost" to
 * ::1 first — so the server would start, print its URL, and then refuse the
 * connection. Omitting the host lets Node bind :: where IPv6 exists (which
 * accepts IPv4 too) and fall back to 0.0.0.0 where it does not. An explicit
 * HOST is still honoured for anyone pinning it to one interface.
 */
const host = process.env.HOST || undefined;
const volume = mountedVolume();
const dataDir = process.env.HEARTH_DATA
  ? path.dirname(path.resolve(process.env.HEARTH_DATA))
  : (volume ?? path.join(ROOT, 'data'));

/*
 * HEARTH_DATA used to name a JSON file and now names the database, so a value
 * carried over from an older install still points at the right directory. The
 * calendar.json beside it, if there is one, is imported on the first open.
 */
const dataFile = process.env.HEARTH_DATA && !process.env.HEARTH_DATA.endsWith('.json')
  ? path.resolve(process.env.HEARTH_DATA)
  : path.join(dataDir, 'calendar.db');
const legacyFile = path.join(dataDir, 'calendar.json');

/*
 * Every install starts empty. A household sets up its own people and its own
 * week, and the invented family that used to be here was nine events and four
 * strangers to delete from a phone before the calendar was yours.
 *
 * The demo is still there behind HEARTH_SEED=on, for looking at the thing with
 * something in it, and is opt-in precisely because the previous rule — seed
 * unless a volume is mounted — turned it back on for exactly the deploy that
 * least wanted it.
 */
const seeding = process.env.HEARTH_SEED === 'on';

assertWritable(dataFile);

const db = openDatabase(dataFile);
const store = new Store(db);
const accounts = new Accounts(db);

store.on('imported', ({ members, events }) => {
  console.log(`  Imported ${events} events and ${members} people from ${legacyFile}`);
});

await store.load({ seed: seeding ? seedState : undefined, legacyFile });

warnIfEphemeral();
warnIfNoPages();

const server = createApp(store, { accounts });

server.listen(port, host, () => {
  const lines = [
    '',
    `  Hearth is running — database at ${dataFile}`,
    '',
    `  TV display   http://localhost:${port}/`,
    `  Phone editor http://localhost:${port}/edit`,
  ];
  for (const address of lanAddresses()) {
    lines.push(`  On your network  http://${address}:${port}/  ·  /edit`);
  }
  if (accounts.empty) {
    lines.push('');
    lines.push('  No accounts yet — open the address above to create the first one.');
  }
  lines.push('');
  console.log(lines.join('\n'));
});

/**
 * Fail on the data directory before the store does, because the message
 * matters: a volume is mounted owned by root, this image runs as an
 * unprivileged user, and "EACCES: permission denied, open '/data/…'" three
 * frames deep in a write does not say to go and change the mount.
 */
function assertWritable(file) {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (error) {
    console.error(
      [
        '',
        `  ✖  Cannot write the calendar to ${dir}`,
        `     ${error.code === 'EACCES' ? 'Permission denied' : error.message}`,
        '',
        '     A mounted volume is usually owned by root, and this image runs as',
        '     an unprivileged user. Give the mount to uid 1000 (the node user),',
        '     or point HEARTH_DATA somewhere writable.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}

/** The host we are deployed on, by its own environment marker, or null. */
function platform() {
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) return 'Railway';
  if (process.env.FLY_APP_NAME) return 'Fly';
  if (process.env.RENDER) return 'Render';
  // Set by our own image, which is a deployment wherever it is running.
  if (process.env.HEARTH_HOSTED) return 'Docker';
  return null;
}

/**
 * A volume to keep the calendar on, but only when a host says it is a host.
 * A bare writable /data is not enough of a signal — plenty of Linux boxes have
 * one — and guessing wrong would quietly move a family's calendar. Asking the
 * platform first means the check can only fire where a volume is the point.
 */
function mountedVolume() {
  if (!platform()) return null;

  // A mount sits on its own device; a directory the image happened to create
  // shares one with the root filesystem. That distinction is the whole point —
  // /app/data exists in our image whether or not anything is mounted over it,
  // and treating the empty one as storage is how a calendar disappears.
  let rootDevice;
  try {
    rootDevice = fs.statSync('/').dev;
  } catch {
    return null;
  }

  for (const candidate of ['/data', '/var/hearth', '/app/data']) {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isDirectory() || stat.dev === rootDevice) continue;
      fs.accessSync(candidate, fs.constants.W_OK);
      return candidate;
    } catch {
      // Not mounted, or not ours to write to — try the next one.
    }
  }
  return null;
}

/**
 * Storing the calendar inside the app directory on a hosted platform means it
 * is gone at the next deploy. That is silent and unrecoverable, so it is worth
 * shouting about while somebody is still watching the deploy log.
 */
function warnIfEphemeral() {
  const host = platform();
  if (!host || volume || process.env.HEARTH_DATA) return;
  console.warn(
    [
      '',
      `  ⚠  Running on ${host} with no volume — the calendar is being written`,
      `     inside the container, and every deploy will wipe it.`,
      '',
      '     Mount a volume at /data (no other setting needed), or point',
      '     HEARTH_DATA at one you have mounted elsewhere.',
      '',
    ].join('\n'),
  );
}

/**
 * The front end is plain files on disk, so a build or image that leaves out
 * public/ still starts, still answers the API, and still signs people in —
 * then serves a 404 for every page. Saying so at start-up turns a puzzling
 * blank site into one line in the deploy log.
 */
function warnIfNoPages() {
  const index = fileURLToPath(new URL('public/index.html', `file://${ROOT}`));
  if (fs.existsSync(index)) return;
  console.warn(
    [
      '',
      '  ⚠  public/ is missing from this build — the API will answer but every',
      `     page will 404. Expected it at ${path.dirname(index)}`,
      '',
    ].join('\n'),
  );
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);
}

const shutdown = async (signal) => {
  console.log(`\n[hearth] ${signal} received, closing…`);
  server.close();
  await store.close();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
