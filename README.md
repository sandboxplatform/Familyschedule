# Hearth

A family calendar that lives on the kitchen TV, with an editor built for the
phone in your pocket.

Open `/` on any TV browser and leave it there: a glanceable board of today and
the week ahead, colour-coded per person, that updates itself the moment anyone
changes anything. Open `/edit` on a phone to add the dentist appointment while
you're still on the call.

![The TV display](docs/screenshot-tv.png)

<p align="center">
  <img src="docs/screenshot-phone.png" alt="The phone editor" width="290">
  <img src="docs/screenshot-phone-edit.png" alt="Adding an event" width="290">
</p>

| TV display (`/`) | Phone editor (`/edit`) |
| --- | --- |
| Today's agenda, what's happening now, what's next | Add, edit and delete in a couple of taps |
| Four views: day, week, month or agenda | Repeat rules without the iCal jargon |
| Per-person colours and a "next up" line for everyone | Colour-code the household |
| Optional weather, live clock, light and dark | Installs to the home screen as an app |

## Why it's built this way

- **No cloud, no subscription.** Everything lives on one machine on your own
  network, in a single SQLite file you can back up, copy or open with any
  sqlite client.
- **No build step and no dependencies.** `node server/index.js` is the entire
  install — the database is node's own `node:sqlite`, so there is still nothing
  to install. It runs happily on a Raspberry Pi, an old laptop or a NAS.
- **Live, not polled.** Saves are pushed to every screen over server-sent
  events, so the TV updates while you're still holding the phone.
- **Built for a screen you never touch.** The display view survives wifi
  dropouts, rolls over at midnight, trims busy days to fit, and drifts a few
  pixels every eight minutes so a static layout can't ghost the panel.
- **One layout, every screen.** The same page works fullscreen on a monitor and
  scrolled on a phone — the day rail becomes a list, the month keeps its grid
  with a dot per entry, and the controls move to a bar at the bottom.

## Quick start

```bash
git clone <this repo> hearth
cd hearth
npm start
```

Then open:

- `http://<machine>:4321/` — the TV display
- `http://<machine>:4321/edit` — the phone editor

The first run seeds a demo household so the screen isn't blank; delete the
sample entries from the phone once you've had a look, or start clean with
`HEARTH_SEED=off npm start`.

### Put it on the TV

Most TV browsers just need the URL bookmarked. For a dedicated screen:

```bash
# Raspberry Pi / any Linux box wired to the TV
chromium-browser --kiosk --noerrdialogs --disable-infobars \
  --incognito http://hearth.local:4321/
```

### The four views

A bar at the bottom of the display switches between them, and so do the keys:

| View | Key | What it shows |
| --- | --- | --- |
| **Day** | `D` | Today hour by hour, on a rail against the clock, with a line at the current time. Overlapping entries sit side by side. The rail fits itself to the hours actually in use. |
| **Week** | `W` | The current week, Monday to Sunday, side by side |
| **Month** | `M` | The whole month, today picked out, with a `+N more` marker on busy days |
| **Agenda** | `A` | Today's panel plus the next six days — the default |

`V` cycles the views (`Shift`+`V` goes back), `L` switches between light and
dark, `F` toggles fullscreen, `R` forces a refresh and `E` opens the editor —
as does the **Add or change plans** button in the bar. The mouse cursor fades
out on its own.

Whichever view you pick is remembered by that screen, so the TV in the kitchen
and the tablet in the hall can each sit on a different one. A screen that has
never been given a view follows **Display opens on** in the editor's Settings.

### Put it on a phone

Open `/edit` in the phone's browser and use "Add to Home Screen". It installs as
a standalone app — it is a proper web app manifest with icons, not a bookmark.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `4321` | Port to listen on |
| `HOST` | unset | Interface to bind. Unset binds both IPv4 and IPv6 where available, so `localhost` resolves either way |
| `HEARTH_DATA` | a mounted volume if one is found, else `./data/calendar.db` | Where the database lives |
| `HEARTH_SEED` | on locally, off on a host with a volume | Set to `off` to start with an empty calendar, `on` to force the demo household |

Sign-in needs no configuration at all: accounts live in the database, and the
session signing key is generated on first run and kept there too.

Everything else — family name, theme, week start, starting view, 24-hour clock,
view rotation and weather — is in the editor's Settings tab, so nobody has to
edit a config
file to change how the TV looks.

Weather is off by default. Turn it on, drop in coordinates (or tap "use my
current location") and it pulls a forecast from Open-Meteo: no key, no account,
no bill. If the forecast is unreachable the strip simply disappears.

## Run it as a service

**systemd**

```ini
# /etc/systemd/system/hearth.service
[Unit]
Description=Hearth family calendar
After=network.target

[Service]
WorkingDirectory=/opt/hearth
ExecStart=/usr/bin/node server/index.js
Environment=PORT=4321
Restart=always
User=hearth

[Install]
WantedBy=multi-user.target
```

**Docker**

```bash
docker build -t hearth .
docker run -d --name hearth -p 4321:4321 -v hearth-data:/app/data hearth
```

## How it works

```
server/
  index.js       entry point: config, startup, the URLs it prints
  app.js         node:http router, static files, SSE stream
  store.js       validation + atomic JSON persistence
  recurrence.js  repeat rules expanded into per-day slices
  dates.js       wall-clock date maths (no timezone surprises)
  weather.js     optional Open-Meteo forecast, cached and fail-quiet
public/
  index.html     the TV display
  edit.html      the phone editor
  css/           design tokens (base) + one stylesheet per surface
  js/            api client, formatting, and one module per surface
```

Times are stored as local wall-clock values (`2026-09-18` and `17:30`), never as
UTC instants. A family calendar means "swimming at five", which stays at five
through a daylight-saving change — converting through UTC would only introduce
bugs nobody asked for.

Repeat rules are a deliberate subset of RFC 5545: daily, weekly (on chosen
weekdays), monthly by date, and yearly, each with an interval and an optional
end date or count, plus per-date exceptions so you can skip one week without
losing the series. That covers a fridge calendar without an iCal engine.

### API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/bootstrap` | Settings, people, categories, palette |
| `GET` | `/api/calendar?from&to` | Occurrences expanded and grouped by day |
| `GET` `POST` | `/api/events` | List / create |
| `GET` `PATCH` `DELETE` | `/api/events/:id` | Read / update / delete |
| `POST` | `/api/events/:id/skip` | Drop one date from a series |
| `POST` | `/api/events/:id/end` | Stop a series from a date onwards |
| `GET` `POST` | `/api/members` | List / create people |
| `PATCH` `DELETE` | `/api/members/:id` | Update / remove a person |
| `GET` `PATCH` | `/api/settings` | Display settings |
| `GET` | `/api/weather` | Cached forecast, or `null` |
| `GET` | `/api/stream` | Server-sent change events |
| `GET` `POST` `DELETE` | `/api/session` | Passcode status, sign in, sign out |
| `GET` | `/api/health` | Liveness probe |

## Tests

```bash
npm test
```

47 tests over the recurrence engine (intervals, weekday fan-out, month-end
clamping, leap days, counts, exceptions, multi-day spans), the store
(validation, atomic writes, migrations, series edits) and the HTTP API
(including the live stream and path-traversal refusal), plus the access gate
(cookie flags, throttling, forged and expired sessions). No test framework to
install — it's `node --test`.

## Accounts

The first person to open a new install is asked to create an account — an email
and a password — and is signed in by the act of doing it. After that the same
page is a sign-in, and further accounts are added from **Settings → Add another
account** by somebody already signed in, so a public install cannot collect
strangers.

Nothing is readable without an account. The API answers `401` and pages
redirect to `/login`; only the sign-in page, its assets and `/api/health` stay
open. There is no anonymous mode to forget to turn off.

Passwords are stored as salted scrypt hashes, never in the clear. Signing in
sets a signed, `HttpOnly`, year-long cookie, so a screen on a wall is asked once
and not again after a reboot; phones behave the same. A wrong password and an
unknown email give the same answer, so the form cannot be used to find out who
has an account, and guesses are throttled to 8 per client per 10 minutes.

Signing in from a phone lands on the editor and from anything larger on the
display, so nobody has to know which address to type. The very first sign-in
goes to Settings instead: a brand new household has an empty calendar, and the
useful first move is naming the family and adding people, not staring at a
blank week.

### Weather

Off until you turn it on, in **Settings → Weather**. Type a town and pick it
from the list — it fills in the coordinates for you, and disambiguates the
several places that share a name. Once saved it appears beside the clock on the
display: what it is doing now, and the next three days. Forecasts come from
Open-Meteo, which needs no account and no API key.

## Going live

**Give it a real disk.** The database is a file. On a platform with an

ephemeral filesystem it needs a mounted volume, or every deploy starts the
family from scratch. Mount one at `/data`, `/var/hearth` or `/app/data` and Hearth
finds it — on Railway, Fly or Render, which say so through their own
environment, and in this repo's Docker image, which says so itself. It looks
for a real mount rather than a directory of that name, so an empty lookalike
is never mistaken for storage. Anywhere else, point `HEARTH_DATA` at it. A hosted deploy running without one says so loudly in its
start-up log.

TLS is expected to be terminated by the platform or your reverse proxy; when it
is, the session cookie is automatically marked `Secure` (Hearth reads
`X-Forwarded-Proto`).

### Railway (what this repo is set up for)

Railway runs a normal long-lived container, which is what Hearth wants: the
event stream that keeps the TV in step stays open, and the calendar is a file
on an attached volume. `railway.toml` covers the build, the start command and
the health check; two things have to be done in the dashboard because Railway
does not read them from config.

1. **New Project → Deploy from GitHub repo**, and pick this repository.
2. **Service → Settings → Volumes**: add a volume mounted at `/data`. Without
   it the calendar is wiped on every deploy. The image runs as an unprivileged
   user, so if the mount arrives owned by root the app says so and stops rather
   than failing later mid-write.
3. **Service → Variables**: nothing to set. A volume at `/data` is found on its
   own, a deploy that finds one starts with your own family rather than the
   demo household, and the first person to open the site creates the account.
   Set `HEARTH_DATA` or `HEARTH_SEED` only to override either.

   If you deploy before adding the volume, the start-up log says so in as many
   words rather than quietly writing to a disk that is about to vanish.

4. **Settings → Networking → Generate Domain** for an HTTPS URL, or point a
   custom domain at it. Railway terminates TLS and sets `X-Forwarded-Proto`, so
   the session cookie is marked `Secure` automatically.

Leave app sleeping switched **off**. A kitchen display is the one thing that
should never need waking up, and the TV holds an open connection anyway.

Railway's CLI can do all of the above (`railway init`, `railway up`, and its
variable and volume subcommands) — check `railway --help` for the flags your
version uses, as they move between releases.

Cost is usage-based on the Hobby plan ($5/month, which includes $5 of usage at
the time of writing); a service this small plus a 1 GB volume normally sits
inside that. Check their current pricing before you commit.

### Fly.io

```bash
fly launch --no-deploy --copy-config     # pick a name and a region
fly volumes create hearth_data --size 1
fly deploy
```

### Render

`render.yaml` is a working Blueprint if you'd rather use Render: **New →
Blueprint**, point it at this repo. It asks for a 1 GB disk, and since Render can't mount a disk on a free instance the
blueprint specifies the `starter` plan.

### Your own box

```bash
docker compose up -d
```

Behind Caddy or nginx, proxy to `127.0.0.1:4321` and let the proxy hold the
certificate. A systemd unit is above if you'd rather skip Docker.

## Roadmap

- Read-only iCal subscription feed (school and sports calendars)
- A QR code on the TV that opens the editor on a phone
- Chore rotation and a shared shopping list panel

## License

MIT — see [LICENSE](LICENSE).
