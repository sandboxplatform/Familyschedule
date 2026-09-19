/**
 * Persistence.
 *
 * Rows live in SQLite (see db.js); this keeps a copy in memory because reads
 * are the hot path — expanding a repeating event across a month touches every
 * event there is, on every redraw of every screen — and a household calendar
 * is small enough to hold. Writes go to the database inside a transaction, so
 * what a phone saves is durable before the save is acknowledged.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { isDateKey, isTimeKey, compareKeys } from './dates.js';
import { FREQUENCIES, normalizeRule } from './recurrence.js';
import {
  importLegacyFile,
  readEvents,
  readMembers,
  readSettings,
  transaction,
  writeEvents,
  writeMembers,
  writeSettings,
} from './db.js';

export const CATEGORIES = [
  'general',
  'school',
  'sport',
  'activity',
  'appointment',
  'meal',
  'chore',
  'birthday',
  'trip',
];

export const PALETTE = [
  '#f97362', '#f5a524', '#f2d13d', '#5ac08a',
  '#37b3c4', '#5b8def', '#9b7bf0', '#ef6fb0',
];

const SCHEMA_VERSION = 1;
const MAX_TEXT = 280;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

export function defaultSettings() {
  return {
    familyName: 'Our Family',
    weekStart: 1,
    theme: 'midnight',
    defaultView: 'agenda',
    openRegistration: true,
    clock24h: false,
    rotateSeconds: 0,
    weather: { enabled: false, latitude: null, longitude: null, unit: 'celsius', label: '' },
  };
}

export function emptyState() {
  return { version: SCHEMA_VERSION, settings: defaultSettings(), members: [], events: [] };
}

export class Store extends EventEmitter {
  #db;
  #state;

  constructor(db) {
    super();
    this.#db = db;
    this.#state = emptyState();
  }

  get db() {
    return this.#db;
  }

  /**
   * Loads what is already there, importing a pre-database calendar.json first
   * if one is sitting next to it, and seeding only a genuinely empty install.
   */
  async load({ seed, legacyFile } = {}) {
    if (legacyFile) {
      const imported = importLegacyFile(this.#db, legacyFile, migrate);
      if (imported) this.emit('imported', imported);
    }

    this.#state = {
      version: SCHEMA_VERSION,
      settings: validateSettings({ ...defaultSettings(), ...readSettings(this.#db) }),
      members: readMembers(this.#db),
      events: readEvents(this.#db),
    };

    const empty = !this.#state.members.length && !this.#state.events.length;
    if (empty && seed) {
      this.#state = migrate(seed());
      this.#writeAll();
    } else if (empty) {
      // Still write the defaults, so settings exist to be read back.
      this.#writeAll();
    }
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  get settings() {
    return structuredClone(this.#state.settings);
  }

  get members() {
    return structuredClone(this.#state.members);
  }

  get events() {
    return structuredClone(this.#state.events);
  }

  // -- members ------------------------------------------------------------

  createMember(input) {
    const member = validateMember(input, this.#state.members);
    this.#state.members.push(member);
    this.#commit('members');
    return structuredClone(member);
  }

  updateMember(id, input) {
    const index = this.#state.members.findIndex((m) => m.id === id);
    if (index === -1) throw new NotFoundError(`No member with id ${id}`);
    const merged = { ...this.#state.members[index], ...input, id };
    const member = validateMember(merged, this.#state.members.filter((m) => m.id !== id));
    this.#state.members[index] = member;
    this.#commit('members');
    return structuredClone(member);
  }

  deleteMember(id) {
    const index = this.#state.members.findIndex((m) => m.id === id);
    if (index === -1) throw new NotFoundError(`No member with id ${id}`);
    this.#state.members.splice(index, 1);
    for (const event of this.#state.events) {
      event.memberIds = event.memberIds.filter((memberId) => memberId !== id);
    }
    this.#commit('members');
  }

  // -- events -------------------------------------------------------------

  createEvent(input) {
    const event = validateEvent(input, this.#state.members);
    this.#state.events.push(event);
    this.#commit('events');
    return structuredClone(event);
  }

  updateEvent(id, input) {
    const index = this.#state.events.findIndex((e) => e.id === id);
    if (index === -1) throw new NotFoundError(`No event with id ${id}`);
    const existing = this.#state.events[index];
    const merged = { ...existing, ...input, id, createdAt: existing.createdAt };
    const event = validateEvent(merged, this.#state.members);
    this.#state.events[index] = event;
    this.#commit('events');
    return structuredClone(event);
  }

  deleteEvent(id) {
    const index = this.#state.events.findIndex((e) => e.id === id);
    if (index === -1) throw new NotFoundError(`No event with id ${id}`);
    this.#state.events.splice(index, 1);
    this.#commit('events');
  }

  /** Removes a single date from a repeating series, leaving the rest intact. */
  skipOccurrence(id, date) {
    if (!isDateKey(date)) throw new ValidationError('occurrence date must be YYYY-MM-DD');
    const event = this.#state.events.find((e) => e.id === id);
    if (!event) throw new NotFoundError(`No event with id ${id}`);
    if (!normalizeRule(event.recurrence)) {
      return this.deleteEvent(id);
    }
    if (!event.exceptions.includes(date)) {
      event.exceptions.push(date);
      event.exceptions.sort(compareKeys);
      event.updatedAt = new Date().toISOString();
      this.#commit('events');
    }
    return structuredClone(event);
  }

  /** Ends a series the day before `date` — "we stopped doing swim in March". */
  endSeriesBefore(id, date) {
    if (!isDateKey(date)) throw new ValidationError('date must be YYYY-MM-DD');
    const event = this.#state.events.find((e) => e.id === id);
    if (!event) throw new NotFoundError(`No event with id ${id}`);
    const rule = normalizeRule(event.recurrence);
    if (!rule) return this.deleteEvent(id);
    if (compareKeys(date, event.date) <= 0) return this.deleteEvent(id);
    event.recurrence = { ...rule, count: null, until: previousDay(date) };
    event.updatedAt = new Date().toISOString();
    this.#commit('events');
    return structuredClone(event);
  }

  // -- settings -----------------------------------------------------------

  updateSettings(input) {
    const settings = validateSettings({ ...this.#state.settings, ...input });
    this.#state.settings = settings;
    this.#commit('settings');
    return structuredClone(settings);
  }

  replaceAll(state) {
    this.#state = migrate(state);
    this.#commit('all');
    return this.snapshot();
  }

  /**
   * Writes the touched scope and announces the change. The write is synchronous
   * and transactional: an event is on disk before the phone that saved it is
   * told so, which the previous debounced file write could not promise.
   */
  #commit(scope) {
    try {
      transaction(this.#db, () => {
        if (scope === 'members' || scope === 'all') writeMembers(this.#db, this.#state.members);
        if (scope === 'members' || scope === 'events' || scope === 'all') {
          writeEvents(this.#db, this.#state.events);
        }
        if (scope === 'settings' || scope === 'all') writeSettings(this.#db, this.#state.settings);
      });
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
    this.emit('change', { scope, at: Date.now() });
  }

  #writeAll() {
    transaction(this.#db, () => {
      writeSettings(this.#db, this.#state.settings);
      writeMembers(this.#db, this.#state.members);
      writeEvents(this.#db, this.#state.events);
    });
  }

  async close() {
    this.#db.close();
  }
}

function previousDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// -- validation -----------------------------------------------------------

function text(value, field, { max = MAX_TEXT, required = false } = {}) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    if (required) throw new ValidationError(`${field} is required`);
    return '';
  }
  if (trimmed.length > max) throw new ValidationError(`${field} must be ${max} characters or fewer`);
  return trimmed;
}

function color(value, fallback) {
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())) {
    return value.trim().toLowerCase();
  }
  return fallback;
}

export function validateMember(input, others = []) {
  const name = text(input?.name, 'name', { max: 40, required: true });
  const duplicate = others.some((m) => m.name.toLowerCase() === name.toLowerCase());
  if (duplicate) throw new ValidationError(`There is already someone called ${name}`);
  const fallback = PALETTE[others.length % PALETTE.length];
  return {
    id: typeof input?.id === 'string' && input.id ? input.id : newId(),
    name,
    color: color(input?.color, fallback),
    initials: text(input?.initials, 'initials', { max: 3 }) || initialsFrom(name),
    order: Number.isInteger(input?.order) ? input.order : others.length,
  };
}

function initialsFrom(name) {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function validateEvent(input, members = []) {
  const title = text(input?.title, 'title', { max: 120, required: true });

  if (!isDateKey(input?.date)) throw new ValidationError('date must be a real date (YYYY-MM-DD)');
  const date = input.date;

  let endDate = null;
  if (input?.endDate) {
    if (!isDateKey(input.endDate)) throw new ValidationError('endDate must be YYYY-MM-DD');
    if (compareKeys(input.endDate, date) < 0) throw new ValidationError('endDate cannot be before date');
    endDate = input.endDate === date ? null : input.endDate;
  }

  let startTime = null;
  if (input?.startTime) {
    if (!isTimeKey(input.startTime)) throw new ValidationError('startTime must be HH:MM');
    startTime = input.startTime;
  }

  let endTime = null;
  if (input?.endTime) {
    if (!isTimeKey(input.endTime)) throw new ValidationError('endTime must be HH:MM');
    if (!startTime) throw new ValidationError('an end time needs a start time');
    if (!endDate && input.endTime < startTime) {
      throw new ValidationError('endTime cannot be before startTime');
    }
    endTime = input.endTime;
  }

  const knownIds = new Set(members.map((m) => m.id));
  const memberIds = Array.isArray(input?.memberIds)
    ? [...new Set(input.memberIds.filter((id) => knownIds.has(id)))]
    : [];

  const category = CATEGORIES.includes(input?.category) ? input.category : 'general';

  const recurrence = validateRecurrence(input?.recurrence, date);

  const exceptions = Array.isArray(input?.exceptions)
    ? [...new Set(input.exceptions.filter(isDateKey))].sort(compareKeys)
    : [];

  const now = new Date().toISOString();

  return {
    id: typeof input?.id === 'string' && input.id ? input.id : newId(),
    title,
    date,
    endDate,
    startTime,
    endTime,
    memberIds,
    category,
    location: text(input?.location, 'location', { max: 120 }),
    notes: text(input?.notes, 'notes', { max: MAX_TEXT }),
    recurrence,
    exceptions,
    createdAt: typeof input?.createdAt === 'string' ? input.createdAt : now,
    updatedAt: now,
  };
}

function validateRecurrence(recurrence, date) {
  if (!recurrence || recurrence.freq === 'none' || !recurrence.freq) return null;
  if (!FREQUENCIES.includes(recurrence.freq)) throw new ValidationError('unsupported repeat frequency');
  if (recurrence.until && !isDateKey(recurrence.until)) {
    throw new ValidationError('repeat until must be YYYY-MM-DD');
  }
  if (recurrence.until && compareKeys(recurrence.until, date) < 0) {
    throw new ValidationError('repeat until cannot be before the first date');
  }
  return normalizeRule(recurrence);
}

export function validateSettings(input) {
  const base = defaultSettings();
  const weather = { ...base.weather, ...(input?.weather || {}) };

  return {
    familyName: text(input?.familyName, 'familyName', { max: 40 }) || base.familyName,
    weekStart: input?.weekStart === 0 ? 0 : 1,
    theme: ['midnight', 'daylight'].includes(input?.theme) ? input.theme : base.theme,
    defaultView: ['agenda', 'day', 'week', 'month'].includes(input?.defaultView)
      ? input.defaultView
      : base.defaultView,
    openRegistration:
      input?.openRegistration === undefined ? base.openRegistration : Boolean(input.openRegistration),
    clock24h: Boolean(input?.clock24h),
    rotateSeconds: clampNumber(input?.rotateSeconds, 0, 0, 600),
    weather: {
      enabled: Boolean(weather.enabled),
      latitude: clampNumber(weather.latitude, null, -90, 90),
      longitude: clampNumber(weather.longitude, null, -180, 180),
      unit: weather.unit === 'fahrenheit' ? 'fahrenheit' : 'celsius',
      label: text(weather.label, 'weather label', { max: 40 }),
    },
  };
}

function clampNumber(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function newId() {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

/** Brings any stored document up to the current schema. */
export function migrate(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;

  state.settings = validateSettings(raw.settings || {});

  const members = [];
  for (const candidate of Array.isArray(raw.members) ? raw.members : []) {
    try {
      members.push(validateMember(candidate, members));
    } catch {
      // Skip unreadable rows rather than refusing to start.
    }
  }
  members.sort((a, b) => a.order - b.order);
  state.members = members.map((member, index) => ({ ...member, order: index }));

  const events = [];
  for (const candidate of Array.isArray(raw.events) ? raw.events : []) {
    try {
      events.push(validateEvent(candidate, state.members));
    } catch {
      // Same: one bad row should not take the fridge calendar offline.
    }
  }
  state.events = events;

  return state;
}
