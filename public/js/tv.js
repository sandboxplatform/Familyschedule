/**
 * The kitchen TV view.
 *
 * Runs unattended for weeks: it re-renders on live server events, rolls over
 * at midnight, survives the wifi dropping out, and nudges its own layout every
 * few minutes so a static screen cannot ghost the panel.
 */

import { api, subscribe } from './api.js';
import {
  addDays,
  categoryMeta,
  dayName,
  formatRange,
  formatTime,
  longDate,
  minutesOf,
  monthName,
  nowMinutes,
  sameMonth,
  startOfMonthKey,
  startOfWeekKey,
  todayKey,
  untilLabel,
  weekdayIndex,
} from './format.js';

const CATEGORY_TINT = {
  general: '#74a5ff',
  school: '#f5a524',
  sport: '#5ac08a',
  activity: '#f2d13d',
  appointment: '#37b3c4',
  meal: '#f97362',
  chore: '#9b7bf0',
  birthday: '#ef6fb0',
  trip: '#5b8def',
};

const REFRESH_MS = 5 * 60 * 1000;
const WEATHER_MS = 15 * 60 * 1000;
const BURN_IN_MS = 8 * 60 * 1000;
const AGENDA_DAYS = 6;
const VIEWS = ['agenda', 'day', 'week', 'month'];
const VIEW_KEY = 'hearth.view';

/* The day timeline sizes its rail to the day actually on screen. A fixed
   6am-10pm window gives about 28px an hour on a 720p panel, which is too thin
   to read an entry's title from the sofa, so the rail narrows to the hours in
   use (padded by one either side) and never goes below MIN_RAIL_HOURS. */
const RAIL_FALLBACK = { start: 8, end: 20 };
const MIN_RAIL_HOURS = 6;

let rail = { ...RAIL_FALLBACK };

const el = {
  root: document.documentElement,
  tv: document.getElementById('tv'),
  familyName: document.getElementById('familyName'),
  todayLong: document.getElementById('todayLong'),
  clock: document.getElementById('clock'),
  weather: document.getElementById('weather'),
  main: document.getElementById('main'),
  todayHeading: document.getElementById('todayHeading'),
  todayCount: document.getElementById('todayCount'),
  spotlight: document.getElementById('spotlight'),
  spotlightKind: document.getElementById('spotlightKind'),
  spotlightTitle: document.getElementById('spotlightTitle'),
  spotlightMeta: document.getElementById('spotlightMeta'),
  todayList: document.getElementById('todayList'),
  whoNext: document.getElementById('whoNext'),
  board: document.getElementById('board'),
  boardWrap: document.getElementById('boardWrap'),
  weekNav: document.getElementById('weekNav'),
  weekLabel: document.getElementById('weekLabel'),
  weekPrev: document.getElementById('weekPrev'),
  weekNext: document.getElementById('weekNext'),
  weekToday: document.getElementById('weekToday'),
  timeline: document.getElementById('timeline'),
  month: document.getElementById('month'),
  viewSwitch: document.getElementById('viewSwitch'),
  themeToggle: document.getElementById('themeToggle'),
  themeGlyph: document.getElementById('themeGlyph'),
  legend: document.getElementById('legend'),
  editUrl: document.getElementById('editUrl'),
  status: document.getElementById('status'),
};

const state = {
  settings: null,
  members: new Map(),
  days: [],
  today: todayKey(),
  mode: storedView() || 'agenda',
  /* Weeks away from this one, for paging the week view. Never persisted: a
     screen rebooting should come back to now, not to whenever it was left. */
  weekOffset: 0,
  lastMinute: -1,
};

boot();

async function boot() {
  el.editUrl.textContent = `${location.host}/edit`;
  await refresh();

  subscribe({
    onChange: () => scheduleRefresh(250),
    onStatus: (status) => el.status.setAttribute('data-state', status),
  });

  setInterval(tick, 1000);
  setInterval(() => refresh(), REFRESH_MS);
  setInterval(loadWeather, WEATHER_MS);
  setInterval(shiftPixels, BURN_IN_MS);
  tick();

  el.viewSwitch.addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (button) setMode(button.dataset.view);
  });
  el.themeToggle.addEventListener('click', toggleTheme);
  el.weekPrev.addEventListener('click', () => stepWeek(-1));
  el.weekNext.addEventListener('click', () => stepWeek(1));
  el.weekToday.addEventListener('click', goToThisWeek);

  document.addEventListener('keydown', onKey);
  document.addEventListener('mousemove', showCursorBriefly);
}

let refreshTimer = null;
function scheduleRefresh(delay) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(), delay);
}

async function refresh() {
  try {
    const { from, to } = fetchRange();
    const payload = await api.calendar(from, to);

    state.settings = payload.settings;
    state.today = payload.today;
    state.members = new Map(payload.members.map((member) => [member.id, member]));
    state.days = payload.days;

    applyTheme(payload.settings.theme);
    el.familyName.textContent = payload.settings.familyName;
    el.todayLong.textContent = longDate(payload.today);

    renderLegend();
    // A screen that has been given a view of its own keeps it; anything else
    // follows whatever the household set in the editor.
    setMode(storedView() || payload.settings.defaultView, { persist: false });
    el.status.setAttribute('data-state', 'live');
    loadWeather();
  } catch {
    el.status.setAttribute('data-state', 'reconnecting');
  }
}

function render() {
  if (state.mode === 'month') {
    renderMonth();
    return;
  }
  if (state.mode === 'day') {
    renderToday();
    renderTimeline();
    return;
  }
  renderToday();
  renderBoard();
}

/**
 * The window of days to ask the server for. Month needs the whole grid — which
 * starts before the 1st and runs past the 31st — so the range has to follow the
 * mode rather than being a fixed slice from today.
 */
function fetchRange() {
  const today = todayKey();
  const weekStart = state.settings?.weekStart ?? 1;
  if (state.mode === 'month') {
    const { first, weeks } = monthWindow();
    return { from: first, to: addDays(first, weeks * 7 - 1) };
  }
  if (state.mode === 'week') {
    // A week either side of the one on screen, so stepping is instant and the
    // live stream has something to redraw from before the next fetch lands.
    const shown = addDays(startOfWeekKey(today, weekStart), (state.weekOffset ?? 0) * 7);
    return { from: addDays(shown, -7), to: addDays(shown, 20) };
  }

  const from = startOfWeekKey(today, weekStart);
  return { from, to: addDays(from, 20) };
}

/**
 * How much of the month to draw, and from when.
 *
 * Six weeks always fits the calendar onto the screen and the entries off it: on
 * a 720p panel that is about 85px a day, which is a date and a "+2 more". A
 * screen that cannot show the month usefully is better off showing less of it
 * properly, so the window shrinks to what the height can carry and centres on
 * this week rather than starting at the 1st — the days either side of today are
 * the ones being looked for.
 */
function monthWindow() {
  const weekStart = state.settings?.weekStart ?? 1;
  const today = todayKey();
  const weeks = monthWeeks();

  if (weeks >= 6) {
    // The whole month, laid out from the week its 1st falls in.
    return { first: startOfWeekKey(startOfMonthKey(today), weekStart), weeks: 6, whole: true };
  }

  const thisWeek = startOfWeekKey(today, weekStart);
  // Slightly more ahead than behind: a calendar is mostly asked what is coming.
  const behind = Math.floor((weeks - 1) / 2);
  return { first: addDays(thisWeek, -behind * 7), weeks, whole: false };
}

/** Weeks that fit, from the height a row needs to show about four entries. */
function monthWeeks() {
  const CHROME = 230; // header, weekday names, footer
  const ROW = 104; // a date and roughly four entries
  const available = (window.innerHeight || 0) - CHROME;
  return Math.max(3, Math.min(6, Math.floor(available / ROW)));
}

// -- today ----------------------------------------------------------------

function renderToday() {
  const day = state.days.find((d) => d.date === state.today);
  const items = day ? day.items : [];
  const minutes = nowMinutes();

  el.todayCount.textContent = items.length
    ? `${items.length} ${items.length === 1 ? 'thing' : 'things'} on`
    : '';

  el.todayList.replaceChildren(
    ...(items.length
      ? items.map((item) => todayRow(item, minutes))
      : [blankInstall()
          // "Enjoy it" is the wrong note for a calendar nobody has filled in
          // yet: the day is not clear, the household simply has not started.
          ? emptyState('Nothing here yet', `Add your family and your first plans at ${location.host}/edit`)
          : emptyState('A clear day', 'Nothing scheduled — enjoy it.')]),
  );

  renderSpotlight(items, minutes);
  renderWhoNext(minutes);
  requestAnimationFrame(() => trimOverflow(el.todayList));
}

function todayRow(item, minutes) {
  const li = document.createElement('li');
  li.className = 'today-item';
  li.style.setProperty('--tint', tintFor(item));

  const start = minutesOf(item.startTime);
  const end = minutesOf(item.endTime);
  if (start !== null) {
    const finish = end ?? start + 60;
    if (start <= minutes && minutes < finish) li.classList.add('is-now');
    else if (finish <= minutes) li.classList.add('is-past');
  }

  const when = document.createElement('div');
  when.className = 'when';
  if (item.allDay) {
    when.textContent = item.dayCount > 1 ? `Day ${item.dayIndex + 1}` : 'All day';
  } else {
    when.textContent = formatTime(item.startTime, state.settings.clock24h);
    if (item.endTime) {
      const small = document.createElement('small');
      small.textContent = `to ${formatTime(item.endTime, state.settings.clock24h)}`;
      when.append(small);
    }
  }

  const what = document.createElement('div');
  what.className = 'what';

  const title = document.createElement('p');
  title.className = 'title';
  title.textContent = item.title;

  const sub = document.createElement('p');
  sub.className = 'sub';
  const bits = [];
  const meta = categoryMeta(item.category);
  if (item.category !== 'general') bits.push(`${meta.glyph} ${meta.label}`);
  if (item.location) bits.push(`📍 ${item.location}`);
  if (bits.length) sub.append(document.createTextNode(bits.join('  ·  ')));
  const people = peopleTags(item);
  if (people) sub.append(people);

  what.append(title);
  if (sub.childNodes.length) what.append(sub);
  li.append(when, what);
  return li;
}

function renderSpotlight(items, minutes) {
  const timed = items.filter((item) => item.startTime);

  const running = timed.find((item) => {
    const start = minutesOf(item.startTime);
    const end = minutesOf(item.endTime) ?? start + 60;
    return start <= minutes && minutes < end;
  });

  const next = timed.find((item) => minutesOf(item.startTime) > minutes);
  // Evenings would otherwise leave a hole where the spotlight is, so once
  // today is done we look ahead to the next day that has anything on it.
  const ahead = running || next ? null : nextDayHighlight();
  const focus = running || next || ahead?.item;

  if (!focus) {
    el.spotlight.hidden = true;
    return;
  }

  el.spotlight.hidden = false;
  el.spotlightKind.replaceChildren();
  if (running) {
    const dot = document.createElement('span');
    dot.className = 'live-dot';
    el.spotlightKind.append(dot, document.createTextNode('Happening now'));
  } else if (next) {
    el.spotlightKind.textContent = `Up next · ${untilLabel(minutesOf(focus.startTime) - minutes)}`;
  } else {
    el.spotlightKind.textContent = `First thing ${ahead.label}`;
  }

  el.spotlightTitle.textContent = focus.title;
  const parts = [
    focus.allDay ? 'All day' : formatRange(focus.startTime, focus.endTime, state.settings.clock24h),
  ];
  if (focus.location) parts.push(focus.location);
  const names = focus.memberIds.map((id) => state.members.get(id)?.name).filter(Boolean);
  if (names.length) parts.push(names.join(' & '));
  el.spotlightMeta.textContent = parts.join('  ·  ');
}

/**
 * One line per person: the next thing they personally have on. This is the
 * question a kitchen calendar gets asked most often ("what have I got today?"),
 * and it keeps the panel useful on a quiet evening.
 */
function renderWhoNext(minutes) {
  const members = [...state.members.values()];
  if (!members.length) {
    el.whoNext.hidden = true;
    return;
  }

  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'Next up';

  el.whoNext.hidden = false;
  el.whoNext.replaceChildren(eyebrow, ...members.map((member) => whoRow(member, minutes)));
}

function whoRow(member, minutes) {
  const next = findNextFor(member.id, minutes);
  const row = document.createElement('div');
  row.className = next ? 'who-row' : 'who-row is-free';

  const name = document.createElement('span');
  name.className = 'who-name';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.setProperty('--dot', member.color);
  name.append(dot, document.createTextNode(` ${member.name}`));

  const what = document.createElement('span');
  what.className = 'who-what';
  what.textContent = next ? next.item.title : 'Nothing booked';

  const when = document.createElement('span');
  when.className = 'who-when';
  when.textContent = next ? whenLabel(next.item) : '';

  row.append(name, what, when);
  return row;
}

function findNextFor(memberId, minutes) {
  const index = state.days.findIndex((day) => day.date === state.today);
  if (index === -1) return null;
  for (const day of state.days.slice(index)) {
    for (const item of day.items) {
      if (!item.memberIds.includes(memberId)) continue;
      // Skip anything already finished today.
      if (day.date === state.today && item.startTime) {
        const end = minutesOf(item.endTime) ?? minutesOf(item.startTime) + 60;
        if (end <= minutes) continue;
      }
      return { day, item };
    }
  }
  return null;
}

function whenLabel(item) {
  const time = item.allDay ? '' : formatTime(item.startTime, state.settings.clock24h);
  if (item.date === state.today) return time || 'Today';
  const day = dayName(item.date, 'short');
  return time ? `${day} ${time}` : day;
}

/** The first entry on the next day that has anything scheduled. */
function nextDayHighlight() {
  const index = state.days.findIndex((day) => day.date === state.today);
  if (index === -1) return null;
  for (const day of state.days.slice(index + 1, index + 8)) {
    if (day.items.length) {
      return { item: day.items[0], label: relativeLabel(day.date) };
    }
  }
  return null;
}

function relativeLabel(date) {
  const diff = Math.round((new Date(`${date}T00:00:00`) - new Date(`${state.today}T00:00:00`)) / 86400000);
  if (diff === 1) return 'tomorrow';
  return `on ${dayName(date, 'long')}`;
}

// -- board ----------------------------------------------------------------

function renderBoard() {
  renderWeekNav();
  const days = state.mode === 'week' ? weekDays() : upcomingDays();
  el.board.replaceChildren(...days.map(dayColumn));
  requestAnimationFrame(() => {
    for (const list of el.board.querySelectorAll('.day-items')) trimOverflow(list);
  });
}

function upcomingDays() {
  const index = state.days.findIndex((day) => day.date === state.today);
  const start = index === -1 ? 0 : index + 1;
  return state.days.slice(start, start + AGENDA_DAYS);
}

function weekDays() {
  const start = shownWeekStart();
  const index = state.days.findIndex((day) => day.date === start);
  return index === -1 ? state.days.slice(0, 7) : state.days.slice(index, index + 7);
}

function renderWeekNav() {
  if (state.mode !== 'week') {
    el.weekNav.hidden = true;
    return;
  }
  const start = shownWeekStart();
  el.weekNav.hidden = false;
  el.weekLabel.textContent = state.weekOffset === 0
    ? 'This week'
    : spanLabel(start, addDays(start, 6));
  el.weekToday.hidden = state.weekOffset === 0;
}

/** The Monday (or Sunday) of the week currently on screen. */
function shownWeekStart() {
  const thisWeek = startOfWeekKey(state.today, state.settings?.weekStart ?? 1);
  return addDays(thisWeek, state.weekOffset * 7);
}

function dayColumn(day) {
  const section = document.createElement('div');
  section.className = 'day-col fade-in';
  if (day.date === state.today) section.classList.add('is-today');
  else if (day.date < state.today) section.classList.add('is-past');
  const weekday = weekdayIndex(day.date);
  if (weekday === 0 || weekday === 6) section.classList.add('is-weekend');

  const head = document.createElement('div');
  head.className = 'day-head';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = day.date === state.today ? 'Today' : dayName(day.date, 'short');
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = String(Number(day.date.slice(8)));
  head.append(name, num);

  const list = document.createElement('div');
  list.className = 'day-items';
  if (day.items.length) {
    list.append(...day.items.map(miniCard));
  } else {
    list.append(emptyState('', 'Free'));
  }

  section.append(head, list);
  return section;
}

function miniCard(item) {
  const card = document.createElement('article');
  card.className = 'card';
  if (item.dayCount > 1) card.classList.add('is-span');
  card.style.setProperty('--tint', tintFor(item));

  const time = document.createElement('p');
  time.className = 'time';
  const meta = categoryMeta(item.category);
  time.textContent = item.allDay
    ? `${meta.glyph} ${item.dayCount > 1 ? `Day ${item.dayIndex + 1}/${item.dayCount}` : 'All day'}`
    : `${meta.glyph} ${formatTime(item.startTime, state.settings.clock24h)}`;

  const name = document.createElement('p');
  name.className = 'name';
  name.textContent = item.title;

  card.append(time, name);
  const people = peopleTags(item, 'who');
  if (people) card.append(people);
  return card;
}

// -- day timeline ---------------------------------------------------------

/**
 * One day, hour by hour. Timed entries sit on a rail against the clock so a
 * glance tells you how much of the day is already spoken for; all-day items
 * ride above it because they have no place on a time axis.
 */
function renderTimeline() {
  const day = state.days.find((d) => d.date === state.today);
  const items = day ? day.items : [];
  const allDay = items.filter((item) => item.allDay || !item.startTime);
  const timed = items.filter((item) => !allDay.includes(item));

  rail = railWindow(timed);

  const wrap = document.createElement('div');
  wrap.className = 'timeline-inner';

  if (allDay.length) {
    const strip = document.createElement('div');
    strip.className = 'all-day-strip';
    const label = document.createElement('p');
    label.className = 'eyebrow';
    label.textContent = 'All day';
    strip.append(label, ...allDay.map(miniCard));
    wrap.append(strip);
  }

  const railEl = document.createElement('div');
  railEl.className = 'rail';

  // Hour lines and blocks live in a track inset from the rail's edges, so the
  // first and last labels have room to sit against instead of being clipped.
  const track = document.createElement('div');
  track.className = 'rail-track';

  for (let hour = rail.start; hour <= rail.end; hour += 1) {
    const line = document.createElement('div');
    line.className = 'rail-hour';
    line.style.setProperty('--at', String(railFraction(hour * 60)));
    const tag = document.createElement('span');
    tag.textContent = formatTime(`${String(hour).padStart(2, '0')}:00`, state.settings.clock24h);
    line.append(tag);
    track.append(line);
  }

  // Lanes keep overlapping entries side by side instead of stacked on top of
  // each other — a 4pm and a 4:30pm would otherwise be unreadable.
  for (const [lane, item] of assignLanes(timed)) {
    track.append(timelineBlock(item, lane.index, lane.count));
  }

  // Only mark "now" when the clock is actually on the rail — clamping it would
  // park the line at 6am through the small hours and read as the wrong time.
  const minutes = nowMinutes();
  if (isToday(state.today) && minutes >= rail.start * 60 && minutes <= rail.end * 60) {
    const now = document.createElement('div');
    now.className = 'rail-now';
    now.style.setProperty('--at', String(railFraction(minutes)));
    track.append(now);
  }

  // An empty day keeps its rail rather than collapsing to a line of text — the
  // shape of the screen should not change just because nothing is on.
  if (!timed.length) {
    track.append(emptyBlock('A clear day', 'Nothing scheduled — enjoy it.'));
  }

  railEl.append(track);
  wrap.append(railEl);
  el.timeline.replaceChildren(wrap);
  requestAnimationFrame(() => fitBlocks(track));
}

/**
 * A short entry cannot show everything. How short is a pixel question, not a
 * minutes one — the rail's scale changes with the day and the TV scales its own
 * root font — so each block is measured once laid out and shed a line at a time
 * until it fits. Half a clipped line reads as a rendering fault.
 */
function fitBlocks(track) {
  for (const block of track.querySelectorAll('.rail-block')) {
    if (!overflowing(block)) continue;
    block.classList.add('is-compact');
    if (overflowing(block)) block.classList.add('is-tight');
  }
}

function overflowing(block) {
  const style = getComputedStyle(block);
  const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const content = [...block.children]
    .filter((child) => getComputedStyle(child).display !== 'none')
    .reduce((total, child) => total + child.getBoundingClientRect().height, 0);
  return content + padding > block.getBoundingClientRect().height + 1;
}

/**
 * The hours the rail should span: the day's own range padded by an hour each
 * side, widened to MIN_RAIL_HOURS so a single lunch date does not become a
 * whole screen of one event.
 */
function railWindow(timed) {
  if (!timed.length) return { ...RAIL_FALLBACK };

  const starts = timed.map((item) => minutesOf(item.startTime));
  const ends = timed.map((item) => minutesOf(item.endTime) ?? minutesOf(item.startTime) + 60);
  let start = Math.max(0, Math.floor(Math.min(...starts) / 60) - 1);
  let end = Math.min(24, Math.ceil(Math.max(...ends) / 60) + 1);

  // Grow evenly around the middle until the window is wide enough to read.
  while (end - start < MIN_RAIL_HOURS && (start > 0 || end < 24)) {
    if (start > 0) start -= 1;
    if (end - start < MIN_RAIL_HOURS && end < 24) end += 1;
  }
  return { start, end };
}

/** Where a minute-of-day sits on the rail, clamped to its ends. */
function railFraction(minutes) {
  const from = rail.start * 60;
  const to = rail.end * 60;
  return Math.min(1, Math.max(0, (minutes - from) / (to - from)));
}

function timelineBlock(item, lane, lanes) {
  const start = minutesOf(item.startTime);
  const end = minutesOf(item.endTime) ?? start + 60;

  const block = document.createElement('article');
  block.className = 'rail-block fade-in';
  block.style.setProperty('--tint', tintFor(item));
  block.style.setProperty('--from', String(railFraction(start)));
  block.style.setProperty('--to', String(railFraction(Math.max(end, start + 20))));
  block.style.setProperty('--lane', String(lane));
  block.style.setProperty('--lanes', String(lanes));

  const minutes = nowMinutes();
  if (isToday(state.today)) {
    if (start <= minutes && minutes < end) block.classList.add('is-now');
    else if (end <= minutes) block.classList.add('is-past');
  }

  const when = document.createElement('p');
  when.className = 'time';
  when.textContent = formatRange(item.startTime, item.endTime, state.settings.clock24h);

  const title = document.createElement('p');
  title.className = 'name';
  title.textContent = item.title;

  block.append(when, title);

  const meta = categoryMeta(item.category);
  const bits = [];
  if (item.category !== 'general') bits.push(`${meta.glyph} ${meta.label}`);
  if (item.location) bits.push(`📍 ${item.location}`);
  if (bits.length) {
    const sub = document.createElement('p');
    sub.className = 'sub';
    sub.textContent = bits.join('  ·  ');
    block.append(sub);
  }
  const people = peopleTags(item, 'who');
  if (people) block.append(people);
  return block;
}

/**
 * Greedy lane packing: an entry takes the first lane whose last entry has
 * already finished. Returns each item with the lane it landed in and how many
 * lanes its overlapping cluster needs.
 */
function assignLanes(items) {
  const sorted = [...items].sort((a, b) => minutesOf(a.startTime) - minutesOf(b.startTime));
  const lanes = [];
  const placed = [];

  for (const item of sorted) {
    const start = minutesOf(item.startTime);
    const end = minutesOf(item.endTime) ?? start + 60;
    let index = lanes.findIndex((busyUntil) => busyUntil <= start);
    if (index === -1) {
      index = lanes.length;
      lanes.push(end);
    } else {
      lanes[index] = end;
    }
    placed.push({ item, index, start, end });
  }

  // Width is decided per cluster of mutually overlapping entries, so a lone
  // morning entry stays full width even if the evening is busy.
  return placed.map((entry) => {
    const cluster = placed.filter((other) => other.start < entry.end && entry.start < other.end);
    const count = Math.max(...cluster.map((other) => other.index + 1));
    return [{ index: entry.index, count }, entry.item];
  });
}

// -- month ----------------------------------------------------------------

function renderMonth() {
  const anchor = startOfMonthKey(state.today);
  const { first, weeks, whole } = monthWindow();

  const heading = document.createElement('div');
  heading.className = 'month-head';
  const caption = document.createElement('p');
  caption.className = 'month-name';
  // A window is not "September", so say which days are actually on screen.
  caption.textContent = whole ? monthName(anchor) : spanLabel(first, addDays(first, weeks * 7 - 1));
  heading.append(caption);

  const names = document.createElement('div');
  names.className = 'month-weekdays';
  for (let i = 0; i < 7; i += 1) {
    const cell = document.createElement('span');
    cell.textContent = dayName(addDays(first, i), 'short');
    names.append(cell);
  }

  const grid = document.createElement('div');
  grid.className = 'month-grid';
  grid.style.setProperty('--weeks', String(weeks));

  const byDate = new Map(state.days.map((day) => [day.date, day]));
  for (let i = 0; i < weeks * 7; i += 1) {
    const date = addDays(first, i);
    grid.append(monthCell(date, byDate.get(date), anchor));
  }

  el.month.replaceChildren(heading, names, grid);
  requestAnimationFrame(() => {
    for (const list of el.month.querySelectorAll('.month-items')) trimOverflow(list);
  });
}

/**
 * The span on screen, as the reader's own locale would write it: "Sep 7 – 27"
 * or "7–27 Sept" depending on where they are. Building it by hand from two
 * formatted dates gets the order wrong somewhere — "7 – September 27" — which
 * is what formatRange exists to avoid.
 */
function spanLabel(from, to) {
  const start = parseKeyLocal(from);
  const end = parseKeyLocal(to);
  const options = { day: 'numeric', month: 'short' };

  try {
    return new Intl.DateTimeFormat(undefined, options).formatRange(start, end);
  } catch {
    // Older engines without formatRange still get something readable.
    return `${start.toLocaleDateString(undefined, options)} – ${end.toLocaleDateString(undefined, options)}`;
  }
}

function parseKeyLocal(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function monthCell(date, day, anchor) {
  const cell = document.createElement('div');
  cell.className = 'month-cell';
  if (!sameMonth(date, anchor)) cell.classList.add('is-outside');
  if (date === state.today) cell.classList.add('is-today');
  else if (date < state.today) cell.classList.add('is-past');
  const weekday = weekdayIndex(date);
  if (weekday === 0 || weekday === 6) cell.classList.add('is-weekend');

  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = String(Number(date.slice(8)));
  cell.append(num);

  const list = document.createElement('div');
  list.className = 'month-items';
  for (const item of day?.items || []) list.append(monthPill(item));
  cell.append(list);
  return cell;
}

function monthPill(item) {
  const pill = document.createElement('span');
  pill.className = 'month-pill';
  pill.style.setProperty('--tint', tintFor(item));
  if (!item.allDay && item.startTime) {
    const time = document.createElement('small');
    time.textContent = formatTime(item.startTime, state.settings.clock24h);
    pill.append(time);
  }
  pill.append(document.createTextNode(item.title));
  return pill;
}

function emptyBlock(big, text) {
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  const strong = document.createElement('span');
  strong.className = 'big';
  strong.textContent = big;
  wrap.append(strong, document.createTextNode(text));
  return wrap;
}

function isToday(key) {
  return key === todayKey();
}

// -- shared bits ----------------------------------------------------------

function peopleTags(item, className = 'people') {
  if (!item.memberIds.length) return null;
  const wrap = document.createElement('span');
  wrap.className = className;
  for (const id of item.memberIds) {
    const member = state.members.get(id);
    if (!member) continue;
    const tag = document.createElement('span');
    tag.className = 'person-tag';
    tag.style.setProperty('--tint', member.color);
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.setProperty('--dot', member.color);
    tag.append(dot, document.createTextNode(member.name));
    wrap.append(tag);
  }
  return wrap.childNodes.length ? wrap : null;
}

function tintFor(item) {
  const member = item.memberIds.map((id) => state.members.get(id)).find(Boolean);
  return member ? member.color : CATEGORY_TINT[item.category] || CATEGORY_TINT.general;
}

function emptyState(big, text) {
  const wrap = document.createElement('li');
  wrap.className = 'empty';
  if (big) {
    const strong = document.createElement('span');
    strong.className = 'big';
    strong.textContent = big;
    wrap.append(strong);
  }
  wrap.append(document.createTextNode(text));
  return wrap;
}

/** True on a calendar that has never had anybody or anything put in it. */
function blankInstall() {
  return !state.members.length && state.days.every((day) => !day.items.length);
}

function renderLegend() {
  el.legend.replaceChildren(
    ...[...state.members.values()].map((member) => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.setProperty('--dot', member.color);
      li.append(dot, document.createTextNode(member.name));
      return li;
    }),
  );
}

/**
 * Hides whatever does not fit a column and adds a "+N more" marker, so a busy
 * Saturday degrades gracefully instead of spilling off the screen.
 */
function trimOverflow(list) {
  const existing = list.querySelector('.more');
  if (existing) existing.remove();
  const items = [...list.children];
  for (const item of items) item.hidden = false;

  // Where the list is free to grow — a phone, where the page scrolls instead —
  // it hugs its content, and the last item would otherwise always measure as
  // sitting on the boundary and be trimmed away.
  if (list.scrollHeight <= list.clientHeight + 1) return;

  const bounds = list.getBoundingClientRect();
  const overflowing = items.filter((item) => item.getBoundingClientRect().bottom > bounds.bottom - 2);
  if (!overflowing.length) return;

  // Reserve a line for the marker itself before deciding what to drop.
  const reserve = 22;
  const visible = items.filter((item) => item.getBoundingClientRect().bottom <= bounds.bottom - reserve);
  const hiddenCount = items.length - visible.length;
  if (!hiddenCount) return;

  for (const item of items.slice(visible.length)) item.hidden = true;

  const more = document.createElement(list.tagName === 'UL' ? 'li' : 'div');
  more.className = 'more';
  more.textContent = `+${hiddenCount} more`;
  list.append(more);
}

// -- weather ---------------------------------------------------------------

async function loadWeather() {
  if (!state.settings?.weather?.enabled) {
    el.weather.hidden = true;
    return;
  }
  try {
    const { weather } = await api.weather();
    if (!weather) {
      el.weather.hidden = true;
      return;
    }
    renderWeather(weather);
  } catch {
    el.weather.hidden = true;
  }
}

const WEATHER_GLYPH = {
  clear: '☀️', partly: '🌤️', cloudy: '☁️', fog: '🌫️',
  drizzle: '🌦️', rain: '🌧️', snow: '❄️', storm: '⛈️',
};

function renderWeather(weather) {
  const icon = document.createElement('span');
  icon.className = 'weather-icon glyph';
  icon.textContent = WEATHER_GLYPH[weather.now.icon] || '☁️';

  const block = document.createElement('div');
  const temp = document.createElement('p');
  temp.className = 'temp';
  temp.textContent = weather.now.temperature === null ? '—' : `${weather.now.temperature}${weather.unit}`;
  const cond = document.createElement('p');
  cond.className = 'cond';
  cond.textContent = weather.label ? `${weather.now.label} · ${weather.label}` : weather.now.label;
  block.append(temp, cond);

  const forecast = document.createElement('div');
  forecast.className = 'forecast';
  for (const day of weather.days.slice(1, 4)) {
    const cell = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = `${WEATHER_GLYPH[day.icon] || '☁️'} ${day.high ?? '—'}°`;
    cell.append(strong, document.createTextNode(dayName(day.date, 'short')));
    forecast.append(cell);
  }

  el.weather.replaceChildren(icon, block);
  if (forecast.childNodes.length) el.weather.append(forecast);
  el.weather.hidden = false;
}

// -- ticking ---------------------------------------------------------------

function tick() {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const use24 = state.settings?.clock24h;

  const display = use24 ? String(hours).padStart(2, '0') : String(hours % 12 === 0 ? 12 : hours % 12);
  el.clock.replaceChildren(document.createTextNode(`${display}:${String(minutes).padStart(2, '0')}`));
  if (!use24) {
    const meridiem = document.createElement('span');
    meridiem.className = 'meridiem';
    meridiem.textContent = hours >= 12 ? 'pm' : 'am';
    el.clock.append(meridiem);
  }

  if (minutes === state.lastMinute) return;
  state.lastMinute = minutes;

  if (todayKey() !== state.today) {
    refresh();
    return;
  }
  if (state.settings) renderToday();
  rotateIfDue(now);
}

let lastRotate = Date.now();
function rotateIfDue(now) {
  const seconds = state.settings?.rotateSeconds || 0;
  if (!seconds) return;
  if (now.getTime() - lastRotate < seconds * 1000) return;
  lastRotate = now.getTime();
  // Rotation is a display behaviour, not a choice worth remembering.
  cycleMode(1, { persist: false });
}

function setMode(mode, { persist = true } = {}) {
  const next = VIEWS.includes(mode) ? mode : 'agenda';
  const widened = needsWiderRange(next) && !needsWiderRange(state.mode);

  if (next !== 'week' && state.weekOffset) {
    state.weekOffset = 0;
    clearTimeout(returnTimer);
  }

  state.mode = next;
  el.main.dataset.mode = next;

  el.boardWrap.hidden = next === 'day' || next === 'month';
  el.timeline.hidden = next !== 'day';
  el.month.hidden = next !== 'month';

  for (const button of el.viewSwitch.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === next));
  }

  if (persist) rememberView(next);

  // Month reaches further back and forward than the other views, so it needs a
  // fresh fetch before it can draw anything.
  if (widened) {
    refresh();
    return;
  }
  render();
}

function needsWiderRange(mode) {
  return mode === 'month';
}

/**
 * Steps the week view backwards or forwards. A screen on a wall is left on
 * whatever somebody last pressed, so it finds its way back to this week on its
 * own after a while — a kitchen calendar showing last Tuesday is worse than
 * useless, because it looks current.
 */
let returnTimer = null;
const RETURN_MS = 3 * 60 * 1000;

function stepWeek(by) {
  if (state.mode !== 'week') return;
  state.weekOffset += by;
  scheduleReturnToNow();
  refresh();
}

function goToThisWeek() {
  if (!state.weekOffset) return;
  state.weekOffset = 0;
  clearTimeout(returnTimer);
  refresh();
}

function scheduleReturnToNow() {
  clearTimeout(returnTimer);
  if (!state.weekOffset) return;
  returnTimer = setTimeout(goToThisWeek, RETURN_MS);
}

function cycleMode(step = 1, options) {
  const index = VIEWS.indexOf(state.mode);
  setMode(VIEWS[(index + step + VIEWS.length) % VIEWS.length], options);
}

function storedView() {
  try {
    const value = localStorage.getItem(VIEW_KEY);
    return VIEWS.includes(value) ? value : null;
  } catch {
    // A TV browser in private mode still deserves a working calendar.
    return null;
  }
}

function rememberView(mode) {
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch {
    // Not worth surfacing — the view simply resets on the next reload.
  }
}

// -- theme -----------------------------------------------------------------

function applyTheme(theme) {
  el.root.dataset.theme = theme;
  el.themeGlyph.textContent = theme === 'daylight' ? '☀' : '☾';
  el.themeToggle.setAttribute(
    'title',
    theme === 'daylight' ? 'Switch to dark' : 'Switch to light',
  );
}

/**
 * The toggle writes through to settings rather than staying local, so the phone
 * and every other screen in the house follow the same theme over the live
 * stream. The switch is applied immediately and rolled back if the save fails.
 */
async function toggleTheme() {
  if (!state.settings) return;
  const previous = state.settings.theme;
  const next = previous === 'daylight' ? 'midnight' : 'daylight';

  state.settings.theme = next;
  applyTheme(next);

  try {
    await api.updateSettings({ ...state.settings, theme: next });
  } catch {
    state.settings.theme = previous;
    applyTheme(previous);
  }
}

function shiftPixels() {
  const x = (Math.random() * 8 - 4).toFixed(1);
  const y = (Math.random() * 8 - 4).toFixed(1);
  el.tv.style.setProperty('--burn-x', `${x}px`);
  el.tv.style.setProperty('--burn-y', `${y}px`);
}

// -- input -----------------------------------------------------------------

function onKey(event) {
  // Arrows page the week rather than scrolling, which there is nothing to do.
  if (state.mode === 'week' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    stepWeek(event.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if (event.key === 'Home') {
    event.preventDefault();
    goToThisWeek();
    return;
  }

  switch (event.key.toLowerCase()) {
    case 'v':
      cycleMode(event.shiftKey ? -1 : 1);
      break;
    case 'l':
      toggleTheme();
      break;
    case 'd':
      setMode('day');
      break;
    case 'w':
      setMode('week');
      break;
    case 'm':
      setMode('month');
      break;
    case 'a':
      setMode('agenda');
      break;
    case 'f':
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
      break;
    case 'r':
      refresh();
      break;
    case 'e':
      location.href = '/edit';
      break;
    default:
      break;
  }
}

let cursorTimer = null;
function showCursorBriefly() {
  document.body.classList.add('show-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.remove('show-cursor'), 3000);
}
