/**
 * The database.
 *
 * SQLite through node's own `node:sqlite`, so the promise of no dependencies
 * survives having a real one: tables, foreign keys, indexes and transactions,
 * in a single file that can be copied, backed up or opened with any sqlite
 * client.
 *
 * Calendars that predate this arrive as calendar.json and are imported once,
 * on the first open, inside a transaction — an interrupted import leaves the
 * old file untouched and simply runs again next time.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  email_folded  TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  color    TEXT NOT NULL,
  initials TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  date       TEXT NOT NULL,
  end_date   TEXT,
  start_time TEXT,
  end_time   TEXT,
  category   TEXT NOT NULL DEFAULT 'general',
  location   TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  recurrence TEXT,
  exceptions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Who an event is for. A row per pairing rather than a list in a column, so
-- deleting a member cannot leave a dangling id behind.
CREATE TABLE IF NOT EXISTS event_members (
  event_id  TEXT NOT NULL REFERENCES events(id)  ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, member_id)
);

CREATE INDEX IF NOT EXISTS events_by_date      ON events(date);
CREATE INDEX IF NOT EXISTS event_members_by_member ON event_members(member_id);
`;

export function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  // WAL keeps a reader (the TV redrawing) from blocking a writer (a phone
  // saving), which is the only concurrency this app actually has.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  const version = readMeta(db, 'schema_version');
  if (!version) writeMeta(db, 'schema_version', String(SCHEMA_VERSION));

  return db;
}

export function readMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function writeMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** Runs `fn` in a transaction, rolling back if it throws. */
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The rollback failing would only mask the error worth reporting.
    }
    throw error;
  }
}

// -- reading ---------------------------------------------------------------

export function readSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      // A value we cannot parse is one we did not write; the defaults win.
    }
  }
  return out;
}

export function readMembers(db) {
  return db
    .prepare('SELECT id, name, color, initials, position FROM members ORDER BY position, name')
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      initials: row.initials,
      order: row.position,
    }));
}

export function readEvents(db) {
  const byEvent = new Map();
  for (const row of db.prepare('SELECT event_id, member_id FROM event_members').all()) {
    if (!byEvent.has(row.event_id)) byEvent.set(row.event_id, []);
    byEvent.get(row.event_id).push(row.member_id);
  }

  return db
    .prepare('SELECT * FROM events ORDER BY date, start_time IS NULL DESC, start_time, title')
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title,
      date: row.date,
      endDate: row.end_date,
      startTime: row.start_time,
      endTime: row.end_time,
      memberIds: byEvent.get(row.id) || [],
      category: row.category,
      location: row.location,
      notes: row.notes,
      recurrence: row.recurrence ? JSON.parse(row.recurrence) : null,
      exceptions: JSON.parse(row.exceptions),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

// -- writing ---------------------------------------------------------------

export function writeSettings(db, settings) {
  const statement = db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [key, value] of Object.entries(settings)) {
    statement.run(key, JSON.stringify(value));
  }
}

export function writeMembers(db, members) {
  const keep = new Set(members.map((m) => m.id));
  for (const row of db.prepare('SELECT id FROM members').all()) {
    if (!keep.has(row.id)) db.prepare('DELETE FROM members WHERE id = ?').run(row.id);
  }
  const statement = db.prepare(`
    INSERT INTO members(id, name, color, initials, position)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, color = excluded.color,
      initials = excluded.initials, position = excluded.position
  `);
  members.forEach((member, index) => {
    statement.run(member.id, member.name, member.color, member.initials, member.order ?? index);
  });
}

export function writeEvents(db, events) {
  const keep = new Set(events.map((e) => e.id));
  for (const row of db.prepare('SELECT id FROM events').all()) {
    if (!keep.has(row.id)) db.prepare('DELETE FROM events WHERE id = ?').run(row.id);
  }

  const statement = db.prepare(`
    INSERT INTO events(
      id, title, date, end_date, start_time, end_time,
      category, location, notes, recurrence, exceptions, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, date = excluded.date, end_date = excluded.end_date,
      start_time = excluded.start_time, end_time = excluded.end_time,
      category = excluded.category, location = excluded.location, notes = excluded.notes,
      recurrence = excluded.recurrence, exceptions = excluded.exceptions,
      updated_at = excluded.updated_at
  `);
  const clearMembers = db.prepare('DELETE FROM event_members WHERE event_id = ?');
  const addMember = db.prepare(
    'INSERT OR IGNORE INTO event_members(event_id, member_id) VALUES (?, ?)',
  );

  for (const event of events) {
    statement.run(
      event.id,
      event.title,
      event.date,
      event.endDate ?? null,
      event.startTime ?? null,
      event.endTime ?? null,
      event.category,
      event.location,
      event.notes,
      event.recurrence ? JSON.stringify(event.recurrence) : null,
      JSON.stringify(event.exceptions ?? []),
      event.createdAt,
      event.updatedAt,
    );
    clearMembers.run(event.id);
    for (const memberId of event.memberIds ?? []) addMember.run(event.id, memberId);
  }
}

/**
 * Brings a pre-database calendar.json across, once. The file is left where it
 * is — renaming it would take away the only copy of a household's calendar if
 * anything here turned out to be wrong.
 */
export function importLegacyFile(db, file, migrate) {
  if (readMeta(db, 'imported_from')) return null;
  if (db.prepare('SELECT 1 FROM events LIMIT 1').get()) return null;
  if (db.prepare('SELECT 1 FROM members LIMIT 1').get()) return null;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const state = migrate(JSON.parse(raw));
  transaction(db, () => {
    writeSettings(db, state.settings);
    writeMembers(db, state.members);
    writeEvents(db, state.events);
    writeMeta(db, 'imported_from', file);
    writeMeta(db, 'imported_at', new Date().toISOString());
  });
  return { members: state.members.length, events: state.events.length };
}
