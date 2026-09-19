/**
 * The phone editor.
 *
 * One screen per job — schedule, people, settings — plus a bottom sheet for the
 * event form. Every save goes straight to the server, which pushes the change
 * to the TV over SSE, so the fridge calendar updates while you are still
 * standing there holding the phone.
 */

import { api, subscribe } from './api.js';
import {
  addDays,
  categoryMeta,
  contrastInk,
  describeRecurrence,
  formatTime,
  initials,
  relativeDay,
  todayKey,
  weekdayIndex,
  WEEKDAYS,
} from './format.js';

const AGENDA_DAYS = 28;

const $ = (id) => document.getElementById(id);

const ui = {
  root: document.documentElement,
  viewTitle: $('viewTitle'),
  viewSub: $('viewSub'),
  agenda: $('agenda'),
  jumpDate: $('jumpDate'),
  peopleList: $('peopleList'),
  scrim: $('scrim'),
  eventSheet: $('eventSheet'),
  personSheet: $('personSheet'),
  toast: $('toast'),
  fab: $('fab'),
};

const form = {
  title: $('titleInput'),
  date: $('dateInput'),
  endDate: $('endDateInput'),
  start: $('startTimeInput'),
  end: $('endTimeInput'),
  timeFields: $('timeFields'),
  allDay: $('allDayToggle'),
  memberChips: $('memberChips'),
  categoryChips: $('categoryChips'),
  repeat: $('repeatInput'),
  repeatDetail: $('repeatDetail'),
  weekdayField: $('weekdayField'),
  weekdayPicker: $('weekdayPicker'),
  interval: $('intervalInput'),
  until: $('untilInput'),
  repeatSummary: $('repeatSummary'),
  location: $('locationInput'),
  notes: $('notesInput'),
  actions: $('eventActions'),
  seriesActions: $('seriesActions'),
  sheetTitle: $('eventSheetTitle'),
};

const state = {
  settings: null,
  members: [],
  memberMap: new Map(),
  categories: [],
  palette: [],
  days: [],
  user: null,
  from: todayKey(),
  draft: null,
  person: null,
};

boot();

async function boot() {
  wire();
  try {
    const bootstrap = await api.bootstrap();
    applyBootstrap(bootstrap);
    await loadAgenda(todayKey());
    openRequestedView();
  } catch (error) {
    toast(error.message, 'error');
  }

  subscribe({
    onChange: () => refreshQuietly(),
    onStatus: (status) => {
      if (status === 'reconnecting') ui.viewSub.textContent = 'Reconnecting…';
    },
  });
}

function applyBootstrap({ settings, members, categories, palette, user, storage }) {
  state.settings = settings;
  state.members = members;
  state.memberMap = new Map(members.map((m) => [m.id, m]));
  state.categories = categories;
  state.palette = palette;
  state.user = user || null;
  showStorageWarning(storage);
  ui.root.dataset.theme = settings.theme;
  $('signOut').hidden = false;
  $('signedInAs').textContent = state.user ? state.user.email : '';
  renderPeople();
  fillSettings();
  renderCategoryChips();
  renderWeekdayPicker();
}

async function refreshQuietly() {
  try {
    const bootstrap = await api.bootstrap();
    applyBootstrap(bootstrap);
    await loadAgenda(state.from);
  } catch {
    // The stream will fire again on the next change; no need to shout.
  }
}

// -- agenda ----------------------------------------------------------------

async function loadAgenda(from) {
  state.from = from;
  ui.jumpDate.value = from;
  const payload = await api.calendar(from, addDays(from, AGENDA_DAYS - 1));
  state.days = payload.days;
  state.settings = payload.settings;
  ui.root.dataset.theme = payload.settings.theme;
  renderAgenda();
}

function renderAgenda() {
  const populated = state.days.filter((day) => day.items.length);
  const total = populated.reduce((sum, day) => sum + day.items.length, 0);

  ui.viewSub.textContent = total
    ? `${total} ${total === 1 ? 'entry' : 'entries'} over the next ${AGENDA_DAYS} days`
    : `Nothing booked in the next ${AGENDA_DAYS} days`;

  if (!populated.length) {
    ui.agenda.replaceChildren(blankSlate());
    return;
  }

  ui.agenda.replaceChildren(...populated.map(dayGroup));
}

function blankSlate() {
  const wrap = document.createElement('div');
  wrap.className = 'blank';
  const big = document.createElement('span');
  big.className = 'big';
  big.textContent = '🗓️';
  wrap.append(big, document.createTextNode('Nothing here yet. Tap + to add the first thing.'));
  return wrap;
}

function dayGroup(day) {
  const section = document.createElement('section');
  section.className = 'daygroup';
  if (day.date === todayKey()) section.classList.add('is-today');

  const heading = document.createElement('h3');
  heading.append(document.createTextNode(relativeDay(day.date)));
  const date = document.createElement('span');
  date.className = 'date';
  date.textContent = new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
  heading.append(date);

  section.append(heading, ...day.items.map(entryRow));
  return section;
}

function entryRow(item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'entry';
  button.style.setProperty('--tint', tintFor(item));
  button.addEventListener('click', () => openEvent(item));

  const when = document.createElement('div');
  when.className = 'when';
  if (item.allDay) {
    when.textContent = item.dayCount > 1 ? `Day ${item.dayIndex + 1}/${item.dayCount}` : 'All day';
  } else {
    when.textContent = formatTime(item.startTime, state.settings.clock24h);
    if (item.endTime) {
      const small = document.createElement('small');
      small.textContent = `– ${formatTime(item.endTime, state.settings.clock24h)}`;
      when.append(small);
    }
  }

  const body = document.createElement('div');
  const title = document.createElement('p');
  title.className = 'title';
  title.textContent = item.title;
  body.append(title);

  const meta = document.createElement('p');
  meta.className = 'meta';
  const category = categoryMeta(item.category);
  const note = (text) => {
    const span = document.createElement('span');
    span.textContent = text;
    meta.append(span);
  };
  if (item.category !== 'general') note(`${category.glyph} ${category.label}`);
  if (item.location) note(`📍 ${item.location}`);
  if (item.dayCount > 1) note(`Day ${item.dayIndex + 1} of ${item.dayCount}`);
  if (item.repeats) note('🔁 Repeats');
  for (const id of item.memberIds) {
    const member = state.memberMap.get(id);
    if (!member) continue;
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.style.setProperty('--tint', member.color);
    pill.textContent = member.name;
    meta.append(pill);
  }
  if (meta.childNodes.length) body.append(meta);

  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '›';

  button.append(when, body, chev);
  return button;
}

function tintFor(item) {
  const member = item.memberIds.map((id) => state.memberMap.get(id)).find(Boolean);
  if (member) return member.color;
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#74a5ff';
}

// -- event sheet -----------------------------------------------------------

function newDraft() {
  const now = new Date();
  const rounded = new Date(now.getTime() + (30 - (now.getMinutes() % 30)) * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    id: null,
    occurrenceDate: null,
    title: '',
    date: state.from >= todayKey() ? state.from : todayKey(),
    endDate: '',
    startTime: `${pad(rounded.getHours())}:${pad(rounded.getMinutes())}`,
    endTime: '',
    memberIds: new Set(),
    category: 'general',
    location: '',
    notes: '',
    recurrence: { freq: 'none', interval: 1, byWeekday: new Set(), until: '' },
    repeats: false,
  };
}

async function openEvent(item) {
  try {
    const { event } = await api.getEvent(item.eventId);
    state.draft = {
      id: event.id,
      occurrenceDate: item.occurrenceDate,
      title: event.title,
      date: event.date,
      endDate: event.endDate || '',
      startTime: event.startTime || '',
      endTime: event.endTime || '',
      memberIds: new Set(event.memberIds),
      category: event.category,
      location: event.location,
      notes: event.notes,
      recurrence: {
        freq: event.recurrence?.freq || 'none',
        interval: event.recurrence?.interval || 1,
        byWeekday: new Set(event.recurrence?.byWeekday || []),
        until: event.recurrence?.until || '',
      },
      repeats: Boolean(event.recurrence),
    };
    fillEventForm();
    form.sheetTitle.textContent = 'Edit event';
    form.actions.hidden = false;
    form.seriesActions.hidden = !state.draft.repeats;
    openSheet(ui.eventSheet);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openNewEvent() {
  state.draft = newDraft();
  fillEventForm();
  form.sheetTitle.textContent = 'New event';
  form.actions.hidden = true;
  form.seriesActions.hidden = true;
  openSheet(ui.eventSheet);
  setTimeout(() => form.title.focus(), 320);
}

function fillEventForm() {
  const draft = state.draft;
  form.title.value = draft.title;
  form.date.value = draft.date;
  form.endDate.value = draft.endDate;
  form.start.value = draft.startTime;
  form.end.value = draft.endTime;
  form.location.value = draft.location;
  form.notes.value = draft.notes;
  form.repeat.value = draft.recurrence.freq;
  form.interval.value = String(draft.recurrence.interval);
  form.until.value = draft.recurrence.until;

  setToggle(form.allDay, !draft.startTime);
  form.timeFields.hidden = !draft.startTime;

  renderMemberChips();
  renderCategoryChips();
  renderWeekdayPicker();
  syncRepeatFields();
}

function renderMemberChips() {
  const selected = state.draft?.memberIds ?? new Set();
  form.memberChips.replaceChildren(
    ...state.members.map((member) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip-btn';
      chip.style.setProperty('--tint', member.color);
      chip.setAttribute('aria-pressed', String(selected.has(member.id)));

      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.style.setProperty('--avatar', member.color);
      avatar.style.color = contrastInk(member.color);
      avatar.textContent = member.initials || initials(member.name);

      chip.append(avatar, document.createTextNode(member.name));
      chip.addEventListener('click', () => {
        if (selected.has(member.id)) selected.delete(member.id);
        else selected.add(member.id);
        chip.setAttribute('aria-pressed', String(selected.has(member.id)));
      });
      return chip;
    }),
  );

  if (!state.members.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'No people added yet — add them from the People tab to colour-code the TV.';
    form.memberChips.append(hint);
  }
}

function renderCategoryChips() {
  const current = state.draft?.category ?? 'general';
  form.categoryChips.replaceChildren(
    ...state.categories.map((category) => {
      const meta = categoryMeta(category);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip-btn';
      chip.setAttribute('aria-pressed', String(category === current));
      chip.append(document.createTextNode(`${meta.glyph} ${meta.label}`));
      chip.addEventListener('click', () => {
        state.draft.category = category;
        for (const sibling of form.categoryChips.children) {
          sibling.setAttribute('aria-pressed', String(sibling === chip));
        }
      });
      return chip;
    }),
  );
}

function renderWeekdayPicker() {
  const selected = state.draft?.recurrence.byWeekday ?? new Set();
  const order = state.settings?.weekStart === 0 ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0];
  form.weekdayPicker.replaceChildren(
    ...order.map((day) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip-btn';
      chip.textContent = WEEKDAYS[day][0];
      chip.setAttribute('aria-label', WEEKDAYS[day]);
      chip.setAttribute('aria-pressed', String(selected.has(day)));
      chip.addEventListener('click', () => {
        if (selected.has(day)) selected.delete(day);
        else selected.add(day);
        chip.setAttribute('aria-pressed', String(selected.has(day)));
        syncRepeatFields();
      });
      return chip;
    }),
  );
}

function syncRepeatFields() {
  const freq = form.repeat.value;
  form.repeatDetail.hidden = freq === 'none';
  form.weekdayField.hidden = freq !== 'weekly';

  // Default a weekly repeat to the weekday of the event itself.
  if (freq === 'weekly' && state.draft && !state.draft.recurrence.byWeekday.size && form.date.value) {
    state.draft.recurrence.byWeekday.add(weekdayIndex(form.date.value));
    renderWeekdayPicker();
  }

  form.repeatSummary.textContent = describeRecurrence({
    freq,
    interval: Number(form.interval.value) || 1,
    byWeekday: [...(state.draft?.recurrence.byWeekday ?? [])].sort(),
    until: form.until.value || null,
  });
}

async function saveEvent(event) {
  event.preventDefault();
  const draft = state.draft;
  const allDay = form.allDay.getAttribute('aria-pressed') === 'true';

  const payload = {
    title: form.title.value,
    date: form.date.value,
    endDate: form.endDate.value || null,
    startTime: allDay ? null : form.start.value || null,
    endTime: allDay ? null : form.end.value || null,
    memberIds: [...draft.memberIds],
    category: draft.category,
    location: form.location.value,
    notes: form.notes.value,
    recurrence:
      form.repeat.value === 'none'
        ? null
        : {
            freq: form.repeat.value,
            interval: Number(form.interval.value) || 1,
            byWeekday: [...draft.recurrence.byWeekday],
            until: form.until.value || null,
          },
  };

  if (!payload.title.trim()) {
    toast('Give it a name first', 'error');
    form.title.focus();
    return;
  }

  try {
    if (draft.id) await api.updateEvent(draft.id, payload);
    else await api.createEvent(payload);
    closeSheets();
    await loadAgenda(state.from);
    toast(draft.id ? 'Saved' : 'Added to the calendar');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function removeEvent() {
  const draft = state.draft;
  if (!draft?.id) return;
  const label = draft.repeats ? 'Delete the whole repeating series?' : 'Delete this event?';
  if (!confirm(label)) return;
  try {
    await api.deleteEvent(draft.id);
    closeSheets();
    await loadAgenda(state.from);
    toast('Deleted');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function skipOccurrence() {
  const draft = state.draft;
  if (!draft?.id || !draft.occurrenceDate) return;
  try {
    await api.skipOccurrence(draft.id, draft.occurrenceDate);
    closeSheets();
    await loadAgenda(state.from);
    toast(`Skipped ${relativeDay(draft.occurrenceDate).toLowerCase()}`);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function endSeries() {
  const draft = state.draft;
  if (!draft?.id || !draft.occurrenceDate) return;
  if (!confirm('Stop this repeating event from this date onwards?')) return;
  try {
    await api.endSeries(draft.id, draft.occurrenceDate);
    closeSheets();
    await loadAgenda(state.from);
    toast('Series ended');
  } catch (error) {
    toast(error.message, 'error');
  }
}

// -- people ----------------------------------------------------------------

function renderPeople() {
  ui.peopleList.replaceChildren(
    ...state.members.map((member) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'person-row';
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.style.setProperty('--avatar', member.color);
      avatar.style.color = contrastInk(member.color);
      avatar.textContent = member.initials || initials(member.name);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = member.name;
      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.textContent = '›';
      row.append(avatar, name, chev);
      row.addEventListener('click', () => openPerson(member));
      return row;
    }),
  );

  if (!state.members.length) {
    const blank = document.createElement('div');
    blank.className = 'blank';
    blank.textContent = 'Add everyone in the house to colour-code the calendar.';
    ui.peopleList.append(blank);
  }
}

function openPerson(member) {
  state.person = member
    ? { id: member.id, name: member.name, color: member.color }
    : { id: null, name: '', color: state.palette[state.members.length % state.palette.length] };

  $('personSheetTitle').textContent = member ? 'Edit person' : 'Add someone';
  $('personName').value = state.person.name;
  $('deletePerson').hidden = !member;
  renderSwatches();
  openSheet(ui.personSheet);
  if (!member) setTimeout(() => $('personName').focus(), 320);
}

function renderSwatches() {
  const container = $('colorSwatches');
  container.replaceChildren(
    ...state.palette.map((color) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'swatch';
      swatch.style.setProperty('--swatch', color);
      swatch.setAttribute('aria-label', `Colour ${color}`);
      swatch.setAttribute('aria-pressed', String(color === state.person.color));
      swatch.addEventListener('click', () => {
        state.person.color = color;
        for (const sibling of container.children) {
          sibling.setAttribute('aria-pressed', String(sibling === swatch));
        }
      });
      return swatch;
    }),
  );
}

async function savePerson(event) {
  event.preventDefault();
  const name = $('personName').value.trim();
  if (!name) {
    toast('Names help — add one', 'error');
    return;
  }
  const payload = { name, color: state.person.color };
  try {
    if (state.person.id) await api.updateMember(state.person.id, payload);
    else await api.createMember(payload);
    closeSheets();
    await refreshQuietly();
    toast('Saved');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function removePerson() {
  if (!state.person?.id) return;
  if (!confirm(`Remove ${state.person.name}? Their events stay, just untagged.`)) return;
  try {
    await api.deleteMember(state.person.id);
    closeSheets();
    await refreshQuietly();
    toast('Removed');
  } catch (error) {
    toast(error.message, 'error');
  }
}

// -- settings --------------------------------------------------------------

function fillSettings() {
  const s = state.settings;
  $('familyNameInput').value = s.familyName;
  $('themeInput').value = s.theme;
  $('weekStartInput').value = String(s.weekStart);
  $('defaultViewInput').value = s.defaultView;
  $('rotateInput').value = String(s.rotateSeconds);
  setToggle($('clockToggle'), s.clock24h);
  setToggle($('weatherToggle'), s.weather.enabled);
  $('weatherFields').hidden = !s.weather.enabled;
  $('weatherLabel').value = s.weather.label || '';
  $('latInput').value = s.weather.latitude ?? '';
  $('lonInput').value = s.weather.longitude ?? '';
  $('unitInput').value = s.weather.unit;
  $('tvLink').href = '/';
  $('tvLink').textContent = `${location.host}/`;
}

async function saveSettings() {
  const payload = {
    familyName: $('familyNameInput').value,
    theme: $('themeInput').value,
    weekStart: Number($('weekStartInput').value),
    defaultView: $('defaultViewInput').value,
    clock24h: $('clockToggle').getAttribute('aria-pressed') === 'true',
    rotateSeconds: Number($('rotateInput').value),
    weather: {
      enabled: $('weatherToggle').getAttribute('aria-pressed') === 'true',
      latitude: $('latInput').value === '' ? null : Number($('latInput').value),
      longitude: $('lonInput').value === '' ? null : Number($('lonInput').value),
      unit: $('unitInput').value,
      label: $('weatherLabel').value,
    },
  };

  try {
    const { settings } = await api.updateSettings(payload);
    state.settings = settings;
    ui.root.dataset.theme = settings.theme;
    fillSettings();
    toast('Settings saved');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function signOut() {
  if (!confirm('Sign out of this device? You will need your email and password again.')) return;
  try {
    await api.signOut();
  } finally {
    location.replace('/login');
  }
}

/**
 * Looks a place up by name and fills in the coordinates behind it. Debounced,
 * because every keystroke would otherwise be a request, and guarded by a
 * sequence number so a slow early search cannot overwrite a fast later one.
 */
let placeTimer = null;
let placeSearchId = 0;

function wirePlaceSearch() {
  const input = $('placeSearch');
  const results = $('placeResults');

  const hide = () => {
    results.hidden = true;
    results.replaceChildren();
  };

  input.addEventListener('input', () => {
    clearTimeout(placeTimer);
    const query = input.value.trim();
    if (query.length < 2) {
      hide();
      return;
    }
    placeTimer = setTimeout(() => runPlaceSearch(query, results, input), 350);
  });

  input.addEventListener('blur', () => {
    // Let a click on a result land before the list disappears.
    setTimeout(hide, 200);
  });
}

async function runPlaceSearch(query, results, input) {
  const id = ++placeSearchId;
  let places = [];
  try {
    ({ places } = await api.places(query));
  } catch {
    // Treated as no matches — the hint below says what to do instead.
  }
  if (id !== placeSearchId) return;

  results.hidden = false;
  if (!places.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Nothing found — you can enter coordinates instead';
    results.replaceChildren(empty);
    return;
  }

  results.replaceChildren(
    ...places.map((place) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = place.label;
      button.addEventListener('click', () => {
        $('latInput').value = String(place.latitude);
        $('lonInput').value = String(place.longitude);
        if (!$('weatherLabel').value.trim()) $('weatherLabel').value = place.name;
        input.value = place.label;
        results.hidden = true;
        results.replaceChildren();
        toast(`${place.name} — now save to show its weather`);
      });
      li.append(button);
      return li;
    }),
  );
}

function useLocation() {
  if (!navigator.geolocation) {
    toast('This browser has no location support', 'error');
    return;
  }
  toast('Finding you…');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      $('latInput').value = position.coords.latitude.toFixed(4);
      $('lonInput').value = position.coords.longitude.toFixed(4);
      toast('Coordinates filled in — now save');
    },
    () => toast('Could not get your location', 'error'),
    { timeout: 8000 },
  );
}

// -- chrome ----------------------------------------------------------------

function wire() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  }

  ui.fab.addEventListener('click', openNewEvent);
  ui.scrim.addEventListener('click', closeSheets);
  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', closeSheets);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSheets();
  });

  $('eventForm').addEventListener('submit', saveEvent);
  $('deleteEvent').addEventListener('click', removeEvent);
  $('skipOccurrence').addEventListener('click', skipOccurrence);
  $('endSeries').addEventListener('click', endSeries);
  form.repeat.addEventListener('change', syncRepeatFields);
  form.interval.addEventListener('change', syncRepeatFields);
  form.until.addEventListener('change', syncRepeatFields);
  form.date.addEventListener('change', () => {
    if (form.repeat.value === 'weekly') {
      state.draft.recurrence.byWeekday.clear();
      syncRepeatFields();
    }
  });
  form.allDay.addEventListener('click', () => {
    const next = form.allDay.getAttribute('aria-pressed') !== 'true';
    setToggle(form.allDay, next);
    form.timeFields.hidden = next;
    if (next) {
      form.start.value = '';
      form.end.value = '';
    }
  });

  $('addPerson').addEventListener('click', () => openPerson(null));
  $('personForm').addEventListener('submit', savePerson);
  $('deletePerson').addEventListener('click', removePerson);

  $('clockToggle').addEventListener('click', () => toggleSwitch($('clockToggle')));
  $('weatherToggle').addEventListener('click', () => {
    const on = toggleSwitch($('weatherToggle'));
    $('weatherFields').hidden = !on;
  });
  $('useLocation').addEventListener('click', useLocation);
  wirePlaceSearch();
  $('saveSettings').addEventListener('click', saveSettings);
  $('signOut').addEventListener('click', signOut);

  ui.jumpDate.addEventListener('change', () => {
    if (ui.jumpDate.value) loadAgenda(ui.jumpDate.value).catch((e) => toast(e.message, 'error'));
  });
}

/**
 * A household that has just been created lands on Settings rather than an
 * empty schedule: the first useful thing to do is say who is in the family and
 * what the display should look like, not stare at a blank week.
 */
/**
 * A hosted deploy with no volume writes into its own container, so the next
 * deploy takes the household with it. The log says so at start-up; this says so
 * to the person it happens to.
 */
function showStorageWarning(storage) {
  const banner = $('storageWarning');
  if (!storage || storage.persistent) {
    banner.hidden = true;
    return;
  }

  const where = storage.platform || 'this host';
  $('storageWarningBody').replaceChildren(
    document.createTextNode(
      `${where} is running Hearth without a persistent volume, so the calendar `
        + 'is being written inside the container. Accounts, people and events '
        + 'are all lost the next time it deploys. Mount a volume at ',
    ),
    Object.assign(document.createElement('code'), { textContent: '/data' }),
    document.createTextNode(' and it will be found automatically.'),
  );
  banner.hidden = false;
}

function openRequestedView() {
  const params = new URLSearchParams(location.search);
  const setup = params.has('setup');
  const requested = params.get('tab');

  if (!setup && !requested) return;
  switchView(requested || 'settings');

  if (setup) {
    ui.viewSub.textContent = 'Start by naming your family';
    toast('Welcome — set up your family here, then add people');
  }

  // Leave the address clean, so a reload is not another first run.
  history.replaceState(null, '', location.pathname);
}

function switchView(name) {
  for (const view of document.querySelectorAll('.view')) {
    view.classList.toggle('is-active', view.id === `view-${name}`);
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === name));
  }
  ui.viewTitle.textContent = { schedule: 'Schedule', people: 'People', settings: 'Settings' }[name];
  ui.fab.hidden = name !== 'schedule';
  if (name === 'schedule') renderAgenda();
  if (name === 'people') ui.viewSub.textContent = `${state.members.length} in the family`;
  if (name === 'settings') ui.viewSub.textContent = 'How the TV looks';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openSheet(sheet) {
  ui.scrim.classList.add('is-open');
  sheet.classList.add('is-open');
  document.body.style.overflow = 'hidden';
}

function closeSheets() {
  ui.scrim.classList.remove('is-open');
  ui.eventSheet.classList.remove('is-open');
  ui.personSheet.classList.remove('is-open');
  document.body.style.overflow = '';
}

function setToggle(button, on) {
  button.setAttribute('aria-pressed', String(on));
  button.querySelector('.switch')?.setAttribute('aria-checked', String(on));
}

function toggleSwitch(button) {
  const next = button.getAttribute('aria-pressed') !== 'true';
  setToggle(button, next);
  return next;
}

let toastTimer = null;
function toast(message, tone = 'ok') {
  ui.toast.textContent = message;
  ui.toast.dataset.tone = tone;
  ui.toast.classList.add('is-open');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('is-open'), 2600);
}
