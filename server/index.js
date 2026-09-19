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
const dataFile = process.env.HEARTH_DATA
  ? path.resolve(process.env.HEARTH_DATA)
  : path.join(volume ?? path.join(ROOT, 'data'), 'calendar.json');

/*
 * The demo household exists so a local evaluation is not a blank screen. A
 * real deploy wants its own family, not nine invented events to delete from a
 * phone — and a mounted volume is what tells the two apart. HEARTH_SEED still
 * decides it outright either way.
 */
const seeding = process.env.HEARTH_SEED
  ? process.env.HEARTH_SEED !== 'off'
  : !volume;

const store = new Store(dataFile);
await store.load({ seed: seeding ? seedState : undefined });

warnIfEphemeral();

const server = createApp(store);

server.listen(port, host, () => {
  const lines = [
    '',
    `  Hearth is running — data at ${dataFile}`,
    '',
    `  TV display   http://localhost:${port}/`,
    `  Phone editor http://localhost:${port}/edit`,
  ];
  for (const address of lanAddresses()) {
    lines.push(`  On your network  http://${address}:${port}/  ·  /edit`);
  }
  lines.push('');
  console.log(lines.join('\n'));
});

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
