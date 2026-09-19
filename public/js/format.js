/** Formatting helpers shared by the TV and the phone editor. */

export const CATEGORY_META = {
  general: { glyph: '•', label: 'General' },
  school: { glyph: '🎒', label: 'School' },
  sport: { glyph: '⚽', label: 'Sport' },
  activity: { glyph: '🎭', label: 'Activity' },
  appointment: { glyph: '🩺', label: 'Appointment' },
  meal: { glyph: '🍽️', label: 'Meal' },
  chore: { glyph: '🧺', label: 'Chore' },
  birthday: { glyph: '🎂', label: 'Birthday' },
  trip: { glyph: '🧳', label: 'Trip' },
};

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function categoryMeta(category) {
  return CATEGORY_META[category] || CATEGORY_META.general;
}

export function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function toKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(key, amount) {
  const date = parseKey(key);
  date.setDate(date.getDate() + amount);
  return toKey(date);
}

export function todayKey() {
  return toKey(new Date());
}

export function weekdayIndex(key) {
  return parseKey(key).getDay();
}

export function startOfWeekKey(key, weekStart = 1) {
  return addDays(key, -((weekdayIndex(key) - weekStart + 7) % 7));
}

export function startOfMonthKey(key) {
  return `${key.slice(0, 7)}-01`;
}

export function sameMonth(a, b) {
  return a.slice(0, 7) === b.slice(0, 7);
}

export function monthName(key, style = 'long') {
  return parseKey(key).toLocaleDateString(undefined, { month: style, year: 'numeric' });
}

export function formatTime(time, clock24h = false) {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  if (clock24h) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const suffix = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour}${suffix}` : `${hour}:${String(m).padStart(2, '0')}${suffix}`;
}

export function formatRange(start, end, clock24h = false) {
  if (!start) return 'All day';
  return end ? `${formatTime(start, clock24h)} – ${formatTime(end, clock24h)}` : formatTime(start, clock24h);
}

export function dayName(key, style = 'short') {
  return parseKey(key).toLocaleDateString(undefined, { weekday: style });
}

export function monthDay(key) {
  return parseKey(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function longDate(key) {
  return parseKey(key).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

/** "Today" / "Tomorrow" / "Saturday" / "Sat 4 Oct" for anything further out. */
export function relativeDay(key, today = todayKey()) {
  const diff = Math.round((parseKey(key) - parseKey(today)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return parseKey(key).toLocaleDateString(undefined, { weekday: 'long' });
  return parseKey(key).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function minutesOf(time) {
  if (!time) return null;
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function nowMinutes(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

/** "in 20 min" / "in 2h 15m" / "now" — used by the TV's up-next banner. */
export function untilLabel(minutes) {
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
}

export function initials(name) {
  const parts = String(name).split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Readable text colour for a filled swatch of `hex`. */
export function contrastInk(hex) {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return luminance > 0.45 ? '#0b0f16' : '#ffffff';
}

export function describeRecurrence(recurrence) {
  if (!recurrence || recurrence.freq === 'none') return '';
  const { freq, interval = 1, byWeekday = [], until, count } = recurrence;
  let base;
  if (freq === 'daily') base = interval === 1 ? 'Every day' : `Every ${interval} days`;
  else if (freq === 'weekly') {
    const days = byWeekday.length ? byWeekday.map((d) => WEEKDAYS[d]).join(', ') : '';
    const every = interval === 1 ? 'Weekly' : `Every ${interval} weeks`;
    base = days ? `${every} · ${days}` : every;
  } else if (freq === 'monthly') base = interval === 1 ? 'Monthly' : `Every ${interval} months`;
  else if (freq === 'yearly') base = 'Every year';
  else base = '';
  if (until) base += ` until ${monthDay(until)}`;
  else if (count) base += ` · ${count} times`;
  return base;
}
