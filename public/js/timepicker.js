/**
 * A time field that says what it means.
 *
 * `<input type="time">` draws a native picker whose 12- or 24-hour shape comes
 * from the device's own locale, not from this app's setting — so a household
 * that chose a 12-hour clock could still be handed a 24-hour spinner on a
 * phone, with am and pm nowhere to be seen. This is plain selects and a pair of
 * buttons instead: the same everywhere, and am/pm is a thing you tap rather
 * than a thing you scroll to.
 *
 * Values in and out are always 24-hour "HH:MM", or '' for no time at all.
 */

const MINUTE_STEP = 5;

export function createTimePicker(root, { clock24h = false, onChange } = {}) {
  let hour = null; // 0-23, or null for empty
  let minute = 0;

  const hourSelect = document.createElement('select');
  hourSelect.className = 'time-hour';
  hourSelect.setAttribute('aria-label', 'Hour');

  const minuteSelect = document.createElement('select');
  minuteSelect.className = 'time-minute';
  minuteSelect.setAttribute('aria-label', 'Minute');

  const meridiem = document.createElement('div');
  meridiem.className = 'time-meridiem';
  const am = meridiemButton('AM');
  const pm = meridiemButton('PM');
  meridiem.append(am, pm);

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'time-clear';
  clear.textContent = 'Clear';
  clear.setAttribute('aria-label', 'Clear the time');

  root.replaceChildren(hourSelect, colon(), minuteSelect, meridiem, clear);

  function meridiemButton(label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      // Tapping am or pm on an empty field is a way of starting to set one.
      if (hour === null) hour = label === 'AM' ? 9 : 17;
      const isPm = label === 'PM';
      hour = (hour % 12) + (isPm ? 12 : 0);
      render();
      onChange?.(value());
    });
    return button;
  }

  function colon() {
    const span = document.createElement('span');
    span.className = 'time-colon';
    span.textContent = ':';
    return span;
  }

  function buildOptions() {
    hourSelect.replaceChildren();
    const blank = new Option('--', '');
    hourSelect.append(blank);
    if (clock24h) {
      for (let h = 0; h < 24; h += 1) {
        hourSelect.append(new Option(String(h).padStart(2, '0'), String(h)));
      }
    } else {
      // 12 first, the way a clock face reads, so noon and midnight are not
      // hiding at the far end of the list.
      for (const h of [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
        hourSelect.append(new Option(String(h), String(h)));
      }
    }

    minuteSelect.replaceChildren();
    for (let m = 0; m < 60; m += MINUTE_STEP) {
      minuteSelect.append(new Option(String(m).padStart(2, '0'), String(m)));
    }

    meridiem.hidden = clock24h;
  }

  function render() {
    if (hour === null) {
      hourSelect.value = '';
      minuteSelect.value = String(minute);
      am.setAttribute('aria-pressed', 'false');
      pm.setAttribute('aria-pressed', 'false');
      clear.hidden = true;
      return;
    }

    hourSelect.value = clock24h ? String(hour) : String(hour % 12 === 0 ? 12 : hour % 12);
    minuteSelect.value = String(minute);
    const isPm = hour >= 12;
    am.setAttribute('aria-pressed', String(!isPm));
    pm.setAttribute('aria-pressed', String(isPm));
    clear.hidden = false;
  }

  function value() {
    if (hour === null) return '';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  hourSelect.addEventListener('change', () => {
    if (hourSelect.value === '') {
      hour = null;
    } else if (clock24h) {
      hour = Number(hourSelect.value);
    } else {
      // Keep whichever half of the day is already chosen; a fresh field starts
      // in the morning, which is where most things are put.
      const wasPm = hour !== null && hour >= 12;
      hour = (Number(hourSelect.value) % 12) + (wasPm ? 12 : 0);
    }
    render();
    onChange?.(value());
  });

  minuteSelect.addEventListener('change', () => {
    minute = Number(minuteSelect.value);
    // A minute on its own is not a time; assume the morning until told.
    if (hour === null) hour = 9;
    render();
    onChange?.(value());
  });

  clear.addEventListener('click', () => {
    hour = null;
    minute = 0;
    render();
    onChange?.(value());
  });

  buildOptions();
  render();

  return {
    get value() {
      return value();
    },

    set(next) {
      if (!next) {
        hour = null;
        minute = 0;
      } else {
        const [h, m] = String(next).split(':').map(Number);
        hour = Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : null;
        // Snap onto the step, so a time typed elsewhere still shows a value
        // the list actually contains.
        minute = Number.isFinite(m) ? Math.round(m / MINUTE_STEP) * MINUTE_STEP % 60 : 0;
      }
      render();
    },

    setClock(next) {
      clock24h = Boolean(next);
      buildOptions();
      render();
    },
  };
}
