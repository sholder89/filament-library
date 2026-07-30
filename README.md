# Filament Library

A 3D printing filament inventory that runs in one small Docker container on your
home server, installs to your iPhone home screen as a PWA, and looks right on a
desktop browser too.

Track what you own, what's still sealed, what's open, and what you've burned
through — used-up spools stay in the library as a record instead of vanishing.

---

## What it does

- **Spool cards** — every filament drawn as a spool graphic in its own colour.
  The winding shrinks as the spool empties, so a nearly-gone roll looks like one.
- **Three states** — *Sealed* → *Opened* → *Used up*, with the dates stamped
  automatically. Marking a spool used up keeps the record; only an explicit
  delete removes it.
- **Filter and search** — by state, brand, and type, plus free-text search across
  brand, colour, location and notes. Sort by newest, brand, type, colour, or
  most recently opened.
- **Pre-filled catalogue** — 40 brands (Sunlu, Bambu Lab, Creality, Overture,
  Prusament…) and 24 material types (PLA, PLA+, PETG, ABS, ASA, TPU, PA-CF…).
  Picking a type fills in its typical nozzle and bed temperatures and flags
  whether it wants an enclosure or drying. Anything you type yourself is
  remembered and offered next time.
- **QR labels** — print a QR sticker for a spool through your Voice Label
  Printer. Scanning it opens that spool's page.
- **Works offline** — the app shell and your last-loaded inventory are cached,
  so it opens in the workshop even when the WiFi doesn't.

---

## Running it

On your Linux server:

```bash
cd FilamentLibrary && cp .env.example .env
```

Edit `.env` if you want label printing (see below), then:

```bash
docker compose up -d --build
```

Open `http://<server-ip>:8088`. That's it — the database is created on first
run at `./data/filament.db`.

To update after changing anything:

```bash
docker compose up -d --build
```

### Add it to your iPhone

Open the app in **Safari** → Share → **Add to Home Screen**. It launches
full-screen with no browser chrome.

> iOS only installs PWAs from Safari, not Chrome. If "Add to Home Screen" is
> missing, you're in the wrong browser.

---

## Configuration

Everything is optional — the app runs with an empty `.env`.

| Variable | Default | What it does |
|---|---|---|
| `HOST_PORT` | `8088` | Port on the server |
| `TZ` | `UTC` | Timezone, so "opened today" matches your day |
| `APP_BASE_URL` | *(auto)* | URL the QR codes point at. Auto-detects from how you reached the app, which is right on a home LAN. Set it if you're behind a reverse proxy. |
| `LABEL_RELAY_URL` | — | Voice Label Printer relay server |
| `LABEL_TOKEN` | — | Must match the relay's `LABEL_TOKEN` |
| `LABEL_SIZE` | `2x1` | Label size — `2x1`, `4x2`, `4x6`, `3x2`, `2x0.5`, `1.1x3.5`, `1.1x2.4` |
| `LABEL_QR_SHOW_TEXT` | `0` | Print a caption under the QR. See the note below. |
| `LABEL_NAME_LABEL` | `0` | Also print a second plain-text label with the spool description |
| `LABEL_MODE` | `auto` | `relay`, `direct`, or `auto` |
| `LABEL_CLIENT_URL` | — | Bypass the relay and talk to the Windows client directly |

---

## Label printing

Printing goes through your Voice Label Printer **relay server** — the same path
Alexa and Siri use. The app posts the job, and the Windows client picks it up on
its next poll.

```env
LABEL_RELAY_URL=https://your-relay-server.com
LABEL_TOKEN=your-secret-token
```

The style travels **with the job**, so filament labels never touch the printer's
saved settings — your pinned default style survives, and your next voice print
won't come out as a QR code.

> **Requires the relay change.** This uses the per-job `style` field added to
> `POST /webhook`. Deploy the updated `server/app.py` and restart the Windows
> client. Without it, labels print in whatever style the printer is currently
> set to.

**On `LABEL_QR_SHOW_TEXT`:** the QR preset builds its caption from the QR data
itself, so turning this on just repeats the URL under the code. It's off by
default for a clean code-only sticker. If you want readable text on the spool,
use `LABEL_NAME_LABEL=1` instead — that prints a second label reading
"Sunlu PLA+ Galaxy Black".

Each spool's page also shows its QR on screen, so you can scan or screenshot one
without printing anything.

### Direct mode

If you'd rather skip the relay, point the app at the Windows client's own web UI:

```env
LABEL_MODE=direct
LABEL_CLIENT_URL=http://192.168.1.50:5000
```

That endpoint already takes per-request settings, so it needs no changes to the
label printer — but the Windows PC has to be on and reachable from the container.

---

## Backups

Everything lives in `./data/filament.db`. Copy that folder and you're done.

There's also a JSON export — the ⬇ icon in the header, or:

```bash
curl -o backup.json http://<server-ip>:8088/api/export
```

It includes used-up spools, which the default view hides.

---

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/filaments` | List. Filters: `status`, `brand`, `material`, `q`, `sort`, `include_empty` |
| `POST` | `/api/filaments` | Create. `quantity` adds several identical spools at once |
| `GET` | `/api/filaments/:id` | One spool |
| `PATCH` | `/api/filaments/:id` | Update any subset of fields |
| `DELETE` | `/api/filaments/:id` | Permanently remove the record |
| `POST` | `/api/filaments/:id/open` | Mark opened (stamps `opened_at`) |
| `POST` | `/api/filaments/:id/empty` | Mark used up (stamps `finished_at`, keeps the record) |
| `POST` | `/api/filaments/:id/restore` | Put a used-up spool back |
| `GET` | `/api/filaments/stats` | Counts and total weight on hand |
| `GET` | `/api/catalog` | Brands, materials, colours — seed lists merged with your own |
| `POST` | `/api/print/:id` | Print a QR label |
| `GET` | `/api/print/qr/:id.svg` | QR code as SVG |
| `GET` | `/api/export` | Full JSON dump |

Status transitions keep their own timestamps straight: editing a note never
rewrites the date you opened a spool.

---

## Notes

There's no authentication — this is built for a trusted home network, the same
assumption the Voice Label Printer client makes. Don't port-forward it.

Regenerate the app icons after changing the artwork in `tools/generate-icons.mjs`:

```bash
node tools/generate-icons.mjs
```

### Built with

Node 24 and Express, with SQLite via Node's built-in `node:sqlite` — no native
modules, so the image builds in seconds on any architecture. The frontend is
vanilla ES modules with no build step: what's in `public/` is what runs.
