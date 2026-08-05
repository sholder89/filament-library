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
- **Four densities** — *small* shows just the spool with its type on top and the
  brand on hover, *medium* is the standard card, *large* puts a full read-out
  beside the spool, and *list* is one compact row each. The choice is
  remembered.
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
  the spool graphic. **Translucent** shows a checker grid through the filament,
  the way image editors show transparency, so see-through spools are obvious at a
  glance. Glitter twinkles across 34 flecks, glow breathes a halo past the rim,
  and metallic catches a highlight that sweeps across it. Gradient and dual-color
  take up to three colors. Anything named *rainbow* or *multicolor* is painted as
  a hue sweep.
- **Color where it doesn't move** — a bar down the leading edge of every card,
  and a swatch beside the color's name. The winding on the spool graphic shrinks
  as the spool empties, which is exactly when you're most likely to be checking
  what color it is; these don't. Multi-tone and rainbow filaments get the same
  treatment on both as they do on the winding.
- **Color names that resolve** — 187 known names (the W3C set plus filament
  ones like Galaxy Black and Prusa Orange). Type a name and the swatch follows;
  pick a swatch and the name follows. Choosing a swatch, entering a hex or
  reading one off a label settles it, after which renaming the spool leaves the
  color alone — calling a hand-picked cyan "Snow Mountain Blue" shouldn't drag
  it to navy. Pick a different swatch to go back to guessing from the name.
- **Buy another?** — *Add another sealed one* on a spool's page copies its specs
  into a fresh, unopened record.
- **Pre-filled catalog** — 327 brands and 37 material types, grouped by family
  (PLA, PETG, ABS, TPU, Nylon…). Start typing and the list narrows to what
  matches, with names that begin with what you typed first; type something
  that isn't in the list and it's saved exactly as typed. Brands and types
  you've already used are grouped at the top. Picking a type fills in its
  typical nozzle and bed temperatures and flags whether it wants an enclosure
  or drying.

  The brand list is generated from the [filamentcolors.xyz](https://filamentcolors.xyz)
  public API by `tools/fetch-catalog.mjs` and committed, so nothing at runtime
  depends on their site. Re-run it to refresh. Material types stay
  hand-maintained, because their API's type list is per-product marketing names
  rather than material classes.
- **Weigh it instead of guessing** — put a spool on a kitchen scale, type in what
  it says, and the app works out what's left: *(scale − empty spool) ÷ capacity*.
  The slider is still there for when you can't be bothered.

  Three sources of empty-spool weight, each beating the one below it: a weight
  saved against that one roll, a weight you've saved for the brand under
  **Settings**, and the published figures shipped with the app. Weigh a bare
  spool once and every roll of that brand uses it; anything you've already
  weighed against a single roll can be promoted to the whole brand with one
  button.

  Saving one asks for a brand and a weight, and nothing else unless you want it.
  Behind *More options* it can be narrowed to a spool size, a filament type, or
  a named variant — because brands revise the spool and keep the name. Sunlu are
  on their third and the three weigh 130, 155 and 222 g, so all three can be
  saved side by side. When more than one applies to a roll, the weigh box grows a
  picker; when one applies, it doesn't.

  Worth doing, because the published figures are a moving target: they disagree
  by up to 95 g for one brand, four spools of a single product have been measured
  at 186, 188, 190 and 191 g, and a brand that quietly revises its spool leaves
  the old number in circulation for years. Your own weights are also the part a
  backup can't reconstruct, so they're included in the JSON export.
- **Undo** — marking a spool used up, sealing one you'd opened, moving the
  slider: each says what it did and offers to take it back for a few seconds.
  It restores the old values rather than replaying the opposite action, so the
  percentage and the dates come back as they were, not as a fresh guess.
- **What's running out** — the fill bar turns amber under 25% and red under 10%,
  and *Least left first* sorts the whole library by it. Ties break on the smaller
  spool, since 20% of a 250 g reel is a lot less filament than 20% of a kilo.
- **In the printer** — mark a spool as loaded in a printer or AMS from its page.
  Loaded spools get a coloured ring and sort to the top of every list, with a
  section of their own under the grouped sorts.
- **Add a batch at once** — bought five of the same spool? Set the quantity and
  each one gets its own record, so you can open and use them up individually.
- **Scan the label** — photograph a spool label and the brand, type, color,
  finish, diameter, weight and temperatures fill themselves in. Needs a Google
  Cloud Vision key; without one the button doesn't appear.
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
- **Ambient background** — a faint, slowly-drifting line pattern behind
  everything, tinted to the app's accent color and dimmed further in light mode.
  Off entirely if you have reduced motion set, and paused whenever the tab isn't
  visible.

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

### On a Windows PC, without Docker

There's nothing to compile — the app is plain Node, and SQLite comes from Node
itself — so it runs on a normal desktop with no container runtime at all.

#### 1. Install Node.js

1. Go to **[nodejs.org](https://nodejs.org)**.
2. Click the big green button labelled **LTS**. It downloads an installer
   (`node-v22.x.x-x64.msi` or similar) — around 30 MB.
3. Open the downloaded file and click **Next** through the installer. Accept the
   licence when asked. **Leave every option as it comes.**
4. On the screen offering *"Tools for Native Modules"*, leave the box
   **unticked**. This app doesn't need it, and ticking it starts a long extra
   download.
5. Click **Install**, then **Finish**.

> If you already had a launcher window open, close it and open it again. The
> installer adds Node to the system path, and windows that were already open
> don't pick that up.

You never have to open Node or run it yourself — it just needs to be on the
machine.

#### 2. Run the app

1. Download this project and unzip it anywhere — Desktop is fine.
2. Double-click **`start-windows.cmd`**.

The first run fetches the few libraries the server needs and takes a minute;
after that it's a couple of seconds. A browser opens by itself, and the window
prints an address you can use from a phone on the same network. Closing the
window stops the app.

The launcher checks for Node before doing anything and sends you to the download
page if it's missing or too old, rather than failing at a command prompt.

> **Windows may ask about the firewall** the first time. Allow it on
> **private networks** — that's what lets a phone on the same Wi-Fi reach it.
> Blocking it is fine too; the app still works on the PC itself.

**Reading labels from a photo** needs a Google Cloud Vision key, which is free
for the first 1000 photos a month. Nothing to configure on disk: open
**Settings → Reading labels from a photo**, paste the key in, and press *Check
it works*. See [Label scanning](#label-scanning) for where to get one. Everything
else works without it.

**Where the data goes.** On Windows the database is written to
`%LOCALAPPDATA%\FilamentLibrary\filament.db`, not next to the app. That's
deliberate: Documents and Desktop are synced by OneDrive on most Windows
installs, and a sync client and a SQLite database fight each other — the folder
gets locked mid-write and the app fails to start with "unable to open database
file" for a file that's plainly sitting there. LocalAppData is never synced.
Use **Settings → Download a backup** to take a copy somewhere you choose.

For the same reason the local install uses SQLite's ordinary rollback journal
rather than WAL, which needs sidecar files a synced folder won't reliably allow.
The container still uses WAL, where it works properly.

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
| `VISION_API_KEY` | — | Google Cloud Vision key, enables label scanning. Overrides anything set in the UI |

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

There's also a JSON export — **Settings → Download a backup**, or:

```bash
curl -o backup.json http://<server-ip>:8088/api/export
```

It includes used-up spools, which the default view hides.

**Download a spreadsheet** gives you the same inventory as CSV instead. That one
is for reading rather than restoring, so its columns are named for people, the
grams left are worked out for you, and it carries a byte-order mark so Excel on
Windows doesn't mangle anything non-ASCII.

```bash
curl -o inventory.csv http://<server-ip>:8088/api/export.csv
```

To read a backup back in, use **Restore from a backup** and pick the file. Importing
**merges**: a spool already in the library is left alone, so running the same
backup twice changes nothing and an older backup can't revert edits you've made
since. Ids are preserved, which is what keeps printed QR labels pointing at the
right spool.

```bash
curl -X POST -H 'Content-Type: application/json' \
     -d @backup.json http://<server-ip>:8088/api/import
```

Add `"mode": "overwrite"` to take the file's version of anything that clashes,
or `"mode": "replace"` to clear the library first — for restoring onto a fresh
install. Rows are validated exactly as the normal create route validates them,
and the whole import runs in one transaction, so a bad file leaves no trace.

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
| `GET` | `/api/tares` | Empty-spool weights you've saved |
| `POST` | `/api/tares` | Save one. Upserts on `brand` + `variant` + `material` + `capacity_g` |
| `DELETE` | `/api/tares/:id` | Forget one and fall back to the published figure |
| `POST` | `/api/print/:id` | Print a QR label |
| `GET` | `/api/print/qr/:id.svg` | QR code as SVG |
| `GET` | `/api/export` | Full JSON dump |
| `GET` | `/api/export.csv` | The same inventory as a spreadsheet |
| `POST` | `/api/import` | Restore a dump. `mode`: `merge` (default), `overwrite`, `replace` |

Status transitions keep their own timestamps straight: editing a note never
rewrites the date you opened a spool.

`loaded` marks a spool as being in a printer or AMS right now. It's separate
from `status` — a loaded spool is still `opened`, it just isn't on the shelf —
and it sorts to the top of every list, with its own section under the grouped
sorts. Running a spool out clears it, and duplicating one never copies it.

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

Responses are gzipped, which takes a first load from about 1.3 MB down to 350 KB.
That's done in the app rather than at the reverse proxy because `docker-compose`
also publishes a LAN port straight to the container, and a proxy middleware would
only cover the traffic that goes through the proxy. It matters on a first load
over a weak signal or a VPN; after that the service worker is serving the shell
and nothing crosses the network at all.

---

## License

MIT — see [LICENSE](LICENSE). Do what you like with it; no warranty.

That covers the code in this repository. The three libraries in `public/vendor/`
keep their own licences and are shipped unmodified:

| File | Licence |
|---|---|
| `jsqr.js` | Apache-2.0 |
| `vanta.trunk.min.js` | MIT |
| `p5.min.js` | **LGPL-2.1** |

Apache-2.0 and MIT are permissive and ask for nothing beyond keeping the notice.
LGPL is not: p5 is used here as an unmodified, separately loadable file, which
is what keeps it a library rather than something folded into this project. If
you ever inline it, minify it into a bundle, or patch it, that stops being true
and its terms start applying to what you've built. Swapping the ambient
background for something hand-written — see below — removes the question
entirely.

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

---

## Ambient background

A decorative touch: a faint Vanta.js "trunk" pattern drifts behind the app,
coloured from the theme's own accent (`--bgfx-color` / `--bgfx-opacity` in
`public/styles.css`) so it reads as part of the design rather than a bolt-on.

It's loaded lazily — after the page finishes loading and goes idle — and skips
itself entirely if you have `prefers-reduced-motion` set or the connection has
data-saver on, since the two vendored files together are about 800&nbsp;KB.
Nothing about the app depends on it: every failure path (script load error,
init error, missing browser feature) falls back silently to the plain themed
background.

Renders through **p5.js**, not WebGL/three.js — despite most Vanta effects
being three.js-based, the trunk effect specifically is a p5 sketch. `p5.min.js`
and `vanta.trunk.min.js` are vendored in `public/vendor/` for the same offline
reason as `jsqr.js`; see the header comment in each for the exact pinned
versions and how to regenerate them.

---

## Label scanning

Once a Google Cloud Vision key is configured, the add form grows a **Scan the
label** button. Take a photo of the spool label and the fields fill themselves
in.

Get a key from [console.cloud.google.com](https://console.cloud.google.com):
enable the Cloud Vision API, then **APIs & Services → Credentials → Create
credentials → API key**, and restrict it to the Cloud Vision API. One scan is
one unit and the free tier covers 1000 a month, which is far more than a
filament shelf will ever need.

**Two ways to give it the key.** Set `VISION_API_KEY` in the environment, which
is what the container does — or paste it into **Settings → Reading labels from
a photo**, which is there for running the app on a PC where there's no
environment to configure. There's a *Check it works* button that asks Vision
whether the key is any good, so a wrong one is caught at the keyboard rather
than at the shelf.

The environment always wins where it's set, and a server configured that way
hides the form rather than pretending to be editable. A key typed into the UI is
stored in the database, never sent back to any browser, and deliberately left
out of `/api/export` — a backup gets passed around, and a billing credential
shouldn't travel with it.

The photo goes phone → your server → Vision, never phone → Vision directly, so
the key stays in the server's environment rather than in a page anyone can view
the source of.

**What it reads.** Brand, type, color, finish, diameter, spool weight and print
temperature, each independently — a label with no brand still yields its type.
Anything it isn't sure about is left blank rather than guessed.

**Scan more than once.** Boxes rarely put everything on one face: the brand is
on the front, the specs on a panel round the side. Each photo's text is kept and
sent back with the next one, so they're read together — photograph the front,
then the side, and the second shot fills in what the first missed. Only blanks
are ever filled, so nothing you scanned or typed earlier gets overwritten. The
scanner stays open while the brand, type or color is still missing, and tells you
which of them to go looking for.

`server/label-parse.js` does the interpreting and is tested separately against
text transcribed from real labels:

```bash
node tools/test-label-parse.mjs
```

Those fixtures cover the cases that actually turn up: product codes standing in
for brand names (`CR-PETG` is Creality), values printed on the line below their
heading with a Chinese translation in between, `℃` as a single character, and
colour run together with the weight as `LIGHT BLUE-1KG(N.W)`. If a label of
yours reads wrong, adding it there is the quickest way to pin down why.
