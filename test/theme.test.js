import test from 'node:test';
import assert from 'node:assert/strict';

import { scheduledTheme, nextThemeChange } from '../public/js/format.js';
import { validateSettings, defaultSettings } from '../server/store.js';

const at = (h, m = 0) => new Date(2026, 10, 26, h, m);
const settings = (schedule, theme = 'daylight') => ({ theme, themeSchedule: schedule });
const evening = { enabled: true, darkFrom: '19:00', lightFrom: '07:00' };

test('dark from 7pm, light from 7am', () => {
  const s = settings(evening);
  assert.equal(scheduledTheme(s, at(6, 59)), 'midnight');
  assert.equal(scheduledTheme(s, at(7, 0)), 'daylight');
  assert.equal(scheduledTheme(s, at(12)), 'daylight');
  assert.equal(scheduledTheme(s, at(18, 59)), 'daylight');
  assert.equal(scheduledTheme(s, at(19, 0)), 'midnight');
  assert.equal(scheduledTheme(s, at(23, 30)), 'midnight');
  assert.equal(scheduledTheme(s, at(0, 0)), 'midnight');
});

test('a dark window inside one day works too', () => {
  const s = settings({ enabled: true, darkFrom: '01:00', lightFrom: '05:00' });
  assert.equal(scheduledTheme(s, at(0, 30)), 'daylight');
  assert.equal(scheduledTheme(s, at(3)), 'midnight');
  assert.equal(scheduledTheme(s, at(5)), 'daylight');
});

test('with the schedule off, or nonsensical, the chosen theme holds', () => {
  assert.equal(scheduledTheme(settings({ ...evening, enabled: false }, 'daylight'), at(22)), 'daylight');
  assert.equal(scheduledTheme(settings({ ...evening, enabled: false }, 'midnight'), at(12)), 'midnight');
  assert.equal(scheduledTheme(settings({ enabled: true, darkFrom: '07:00', lightFrom: '07:00' }, 'daylight'), at(22)), 'daylight');
  assert.equal(scheduledTheme({ theme: 'daylight' }, at(22)), 'daylight');
  assert.equal(scheduledTheme(null), 'midnight');
});

test('the next change is the sooner of the two marks', () => {
  const s = settings(evening);
  assert.deepEqual(nextThemeChange(s, at(12)), at(19));
  assert.deepEqual(nextThemeChange(s, at(19)), new Date(2026, 10, 27, 7));
  assert.deepEqual(nextThemeChange(s, at(3)), at(7));
  assert.equal(nextThemeChange(settings({ ...evening, enabled: false })), null);
});

test('the schedule is on by default at 7pm and 7am, and an older calendar gains it', () => {
  assert.deepEqual(defaultSettings().themeSchedule, evening);
  assert.deepEqual(validateSettings({ theme: 'daylight' }).themeSchedule, evening);
});

test('the schedule settings are clamped to sane values', () => {
  const s = validateSettings({ themeSchedule: { enabled: 'yes', darkFrom: '25:00', lightFrom: 'soon' } });
  assert.deepEqual(s.themeSchedule, evening);
  assert.equal(validateSettings({ themeSchedule: { enabled: false } }).themeSchedule.enabled, false);
  assert.equal(validateSettings({ themeSchedule: { darkFrom: '20:30' } }).themeSchedule.darkFrom, '20:30');
});
