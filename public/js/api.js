/** Thin client for the Hearth API, plus the live-update stream. */

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  // A session that expired while the page sat open should land on sign-in
  // rather than throwing errors at whoever walks past the TV.
  if (response.status === 401 && !location.pathname.startsWith('/login')) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace(`/login?next=${next}`);
    throw new Error('Signed out');
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export const api = {
  bootstrap: () => request('/api/bootstrap'),
  calendar: (from, to) => request(`/api/calendar?from=${from}&to=${to}`),
  weather: () => request('/api/weather'),
  places: (query) => request(`/api/places?q=${encodeURIComponent(query)}`),

  listEvents: () => request('/api/events'),
  getEvent: (id) => request(`/api/events/${id}`),
  createEvent: (event) => request('/api/events', { method: 'POST', body: event }),
  updateEvent: (id, event) => request(`/api/events/${id}`, { method: 'PATCH', body: event }),
  deleteEvent: (id) => request(`/api/events/${id}`, { method: 'DELETE' }),
  skipOccurrence: (id, date) => request(`/api/events/${id}/skip`, { method: 'POST', body: { date } }),
  endSeries: (id, date) => request(`/api/events/${id}/end`, { method: 'POST', body: { date } }),

  listMembers: () => request('/api/members'),
  createMember: (member) => request('/api/members', { method: 'POST', body: member }),
  updateMember: (id, member) => request(`/api/members/${id}`, { method: 'PATCH', body: member }),
  deleteMember: (id) => request(`/api/members/${id}`, { method: 'DELETE' }),

  updateSettings: (settings) => request('/api/settings', { method: 'PATCH', body: settings }),

  signOut: () => request('/api/session', { method: 'DELETE' }),
};

/**
 * Subscribes to server-sent changes. EventSource reconnects on its own, so we
 * only surface online/offline transitions to the caller — the TV uses that to
 * show a quiet "reconnecting" dot rather than a broken screen.
 */
export function subscribe({ onChange, onStatus }) {
  let source;
  let closed = false;

  const connect = () => {
    if (closed) return;
    source = new EventSource('/api/stream');
    source.addEventListener('hello', () => onStatus?.('live'));
    source.addEventListener('change', (event) => {
      let detail = {};
      try {
        detail = JSON.parse(event.data);
      } catch {
        // A malformed frame still means "something changed"; refresh anyway.
      }
      onChange?.(detail);
    });
    source.onerror = () => {
      onStatus?.('reconnecting');
      // EventSource retries by itself unless it has hard-closed.
      if (source.readyState === EventSource.CLOSED && !closed) {
        setTimeout(connect, 3000);
      }
    };
  };

  connect();

  return () => {
    closed = true;
    source?.close();
  };
}
