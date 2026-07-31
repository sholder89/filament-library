# Filament Library

A 3D printing filament inventory that runs in one small Docker container on your
home server, installs to your iPhone home screen as a PWA, and looks right on a
desktop browser too.

Track what you own, what's still sealed, what's open, and what you've burned
through — used-up spools stay in the library as a record instead of vanishing.

---

## What it does

- **Spool cards** — every filament drawn as a spool graphic in its own color.
  The winding shrinks as the spool empties, so a nearly-gone roll looks like one.
- **Three states** — *Sealed* → *Opened* → *Used up*, with the dates stamped
  automatically. Marking a spool used up keeps the record; only an explicit
  delete removes it.
- **Filter and search** — by state, and by any combination of brands, types and
  finishes (Sunlu *or* Creality, in PLA *or* PETG). Plus free-text search across
  brand, color, location and notes.
- **Grouped views** — sorting by brand, type or color also groups the library
  under collapsible headings with a count on each, so you can fold away the
  PLA and see what PETG you have. Type headings use the base material, so PLA+,
  PLA Silk and PLA-CF all sit under **PLA** while the cards still show the exact
  variant. Date orders stay flat.
- **Remembers how you left it** — status, brand/type/finish filters and the sort
  order are kept between visits. A search you typed isn't, since a stale query
  would look like missing data.
- **Duplicates stack up** — identical spools collapse into a single card with a
  count. Hover to fan the stack out; click to spread it into individual cards
  and pick one.
- **Special finishes** — silk, glitter, matte, translucent, marble, wood, glow,
  carbon fiber, metallic, gradient and dual-color, each with its own treatment on
  the spool graphic. Glitter really does sparkle, and anything named *rainbow*
  or *multicolor* is painted as a hue sweep instead of one flat color.
- **Color names that resolve** — 187 known names (the W3C set plus filament
  ones like Galaxy Black and Prusa Orange). Type a name and the swatch follows;
  pick a swatch and the name follows.
- **Buy another?** — *Add another sealed one* on a spool's page copies its specs
  into a fresh, unopened record.
- **Pre-filled catalog** — pick from 40 brands (Sunlu, Bambu Lab, Creality,
  Overture, Prusament…) and 24 material types grouped by family (PLA, PETG, ABS,
  TPU, Nylon…), or choose *Something else* to type your own. Brands and types
  you've already used float to the top of the list next time. Picking a type
  fills in its typical nozzle and bed temperatures and flags whether it wants an
  enclosure or drying.
- **Add a batch at once** — bought five of the same spool? Set the quantity and
  each one gets its own record, so you can open and use them up individually.
- **QR labels** — print a QR sticker for a spool through your Voice Label
  Printer. Scanning it opens that spool's page. Each spool's page shows a
  preview of the sticker before you print it, and the add form has an **Add to
  library and print QR** button that does both in one go — one label per spool
  when you're adding a batch.
- **Adjust what's left** — opened spools get a slider on their own page, with
  25/50/75/100% shortcuts. The spool graphic empties as you drag.
- **Scan to open** — the camera button next to *Add* scans a printed QR and
  jumps straight to that spool, using the phone's ultra-wide lens so it can
  focus at sticker range. Needs an https connection (browsers block the camera
  otherwise), which the reverse-proxy setup below gives you.
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
| `PUID` / `PGID` | `1000` | User the app runs as. Set to your own `id -u` / `id -g` if you want the database files owned by your account. |
| `TZ` | `UTC` | Timezone, so "opened today" matches your day |
| `APP_BASE_URL` | *(auto)* | URL the QR codes point at. Auto-detects from how you reached the app, which is right on a home LAN. Set it if you're behind a reverse proxy. |
| `LABEL_RELAY_URL` | — | Voice Label Printer relay server |
| `LABEL_TOKEN` | — | Must match the relay's `LABEL_TOKEN` |
| `LABEL_SIZE` | `2x1` | Label size — `2x1`, `4x2`, `4x6`, `3x2`, `2x0.5`, `1.1x3.5`, `1.1x2.4` |
| `LABEL_QR_SHOW_TEXT` | `1` | Print the brand/type/color beside the QR |
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

Labels print the QR alongside the spool's brand, type and color — one per line,
with the brand in bold — so a sticker is readable without scanning it. Set `LABEL_QR_SHOW_TEXT=0` for a bare code, or
`LABEL_NAME_LABEL=1` to also print a second text-only label.

Defaults live in the code, and `docker-compose.yml` passes these through empty
rather than repeating them — an uncommented line in your `.env` always wins, so
check there first if a setting isn't behaving. To see what the app actually
resolved:

```bash
curl -s http://<server-ip>:8088/api/print/status
```

`show_text: false` there means no text will be printed beside the QR.

Each spool's page shows a preview of the sticker — QR placement, the bold brand
line and the type/color beneath — laid out from the same rules the printer
uses, so you can see what you'll get before committing a label. It's an
approximation: text is auto-sized by estimate rather than measured, so treat it
as a guide to whether a long name fits, not a pixel-exact proof.

The preview doubles as an on-screen QR you can scan or screenshot without
printing anything.

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
| `GET` | `/api/filaments` | List. Filters: `status`, `brand`, `material`, `finish`, `q`, `sort`, `include_empty`. `brand`, `material` and `finish` accept comma-separated values and match any of them |
| `POST` | `/api/filaments` | Create. `quantity` adds several identical spools at once |
| `GET` | `/api/filaments/:id` | One spool |
| `PATCH` | `/api/filaments/:id` | Update any subset of fields |
| `DELETE` | `/api/filaments/:id` | Permanently remove the record |
| `POST` | `/api/filaments/:id/open` | Mark opened (stamps `opened_at`) |
| `POST` | `/api/filaments/:id/empty` | Mark used up (stamps `finished_at`, keeps the record) |
| `POST` | `/api/filaments/:id/restore` | Put a used-up spool back |
| `POST` | `/api/filaments/:id/duplicate` | Copy the specs into new sealed spools (`quantity` optional) |
| `GET` | `/api/filaments/stats` | Counts and total weight on hand |
| `GET` | `/api/catalog` | Brands, materials, colors — seed lists merged with your own |
| `POST` | `/api/print/:id` | Print a QR label |
| `GET` | `/api/print/qr/:id.svg` | QR code as SVG |
| `GET` | `/api/export` | Full JSON dump |

Status transitions keep their own timestamps straight: editing a note never
rewrites the date you opened a spool.

---

## Behind a reverse proxy

The compose file ships Traefik labels using the `proxy` external network, `http`
/ `https` entrypoints and the `cloudflare` cert resolver. The domain is a
placeholder — set your own in `docker-compose.override.yml`, which Compose picks
up automatically and git ignores:

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
```

Labels merge by key, so naming just the two router rules replaces the domain and
leaves everything else intact.

**Set `APP_BASE_URL` to your `https://` hostname.** Traefik terminates TLS and
forwards plain HTTP, so without it the app sees an `http` request and prints QR
codes pointing at `http://` — which then redirect, or fail outright if the plain
entrypoint isn't reachable. `TRUST_PROXY=true` makes the app honour
`X-Forwarded-Proto` for anything else that derives the scheme.

Since the QR URL is printed onto a sticker, whatever hostname you pin has to
resolve from your phone. An internal-only name needs split-horizon DNS or a
matching local record.

---

## Troubleshooting

**The scanner won't read a label**

The scanner uses the **ultra-wide lens** where the phone has one, because it's
the only rear lens that focuses close enough for a sticker-sized code — the main
wide lens can't focus nearer than about 10 cm. This is exactly what the native
camera app does when it silently drops into macro mode; `getUserMedia` never
switches lenses on its own, so the app picks the lens explicitly.

With macro on, hold the label a few centimetres away and fill the marked box.
The **Macro lens** button switches back to the normal rear camera if you'd
rather scan from further out, and tapping the viewfinder asks the lens to
refocus if it's hunting.

If it still won't read, check the resolution shown under **Camera options**. A
label QR is 33 modules across and decoding wants roughly 3 camera pixels per
module, so a low-resolution stream is the limiting factor.


**`unable to open database file` / container restart loop**

The `./data` bind mount is owned by a user the app isn't. Docker creates that
folder as `root` when it doesn't already exist, and the app runs unprivileged.

The container fixes this itself on startup, so first make sure you're on a
current image:

```bash
docker compose up -d --build
```

If it persists, the mount is on a filesystem where `chown` can't work (NFS, some
SMB shares). Set ownership from the host instead:

```bash
sudo chown -R 1000:1000 ./data && docker compose restart
```

Or run the app as the user that already owns the folder — put `PUID` and `PGID`
in `.env` set to your `id -u` and `id -g`.

**Changes made elsewhere aren't showing up**

The app re-reads the library whenever it comes back to the foreground, so
switching to the PWA after editing on another device should be enough. API
responses are sent `no-store`, so nothing should be served from a stale HTTP
cache either. If it persists, check that `/api/filaments` really is returning
`Cache-Control: no-store` and isn't being cached by something in front of it:

```bash
curl -sI http://<server-ip>:8088/api/filaments | grep -i cache
```

**Check what the container is actually doing**

```bash
docker compose logs -f
```

---

## Notes

There's no authentication — this is built for a trusted home network, the same
assumption the Voice Label Printer client makes. Don't port-forward it.

### App icons

Put your artwork in `tools/icon-src/` as `icon-dark.png` and `icon-light.png`
(square, 1024×1024 ideal), then:

```bash
node tools/build-icons.mjs
```

That writes every size into `public/icons/`. The dark version becomes the
home-screen icon, because iOS pins one icon and can't switch it by theme.

Transparency is handled per target: favicons and manifest icons keep it, so the
rounded artwork sits on the browser or launcher background rather than in a
box. The `apple-touch-icon` sizes are flattened onto a colour sampled from
inside the artwork — iOS composites alpha against black, so a transparent icon
shows up blacked-out or not at all.

> **Not seeing a new icon on your iPhone?** iOS caches the home-screen icon from
> the moment you added the page and never refetches it. Delete the icon, quit
> Safari, then add it again.

`tools/generate-icons.mjs` draws the original placeholder icon programmatically
and is only needed if you have no artwork at all.

### Built with

Node 24 and Express, with SQLite via Node's built-in `node:sqlite` — no native
modules, so the image builds in seconds on any architecture. The frontend is
vanilla ES modules with no build step: what's in `public/` is what runs.

---

## Third-party code

`public/vendor/jsqr.js` is [jsQR](https://github.com/cozmo/jsQR) 1.4.0 by Cosmo
Wolfe, Apache-2.0. It's vendored rather than loaded from a CDN because the app
is offline-capable, and it's needed because Safari on iOS has no
`BarcodeDetector`. It's fetched only when the scanner is first opened, not on
page load. To update it:

```bash
npm install jsqr && cp node_modules/jsqr/dist/jsQR.js public/vendor/jsqr.js
```
