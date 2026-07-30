#!/bin/sh
# Fixes up the data directory before handing over to the app.
#
# A bind mount (./data:/data) replaces whatever the image had at /data with the
# host's directory, owned by whoever created it — usually root, because Docker
# creates it when it doesn't exist. The app runs unprivileged, so without this
# it can't create the database file.
#
# We start as root purely to chown the mount, then drop to PUID:PGID and never
# run application code as root.
set -e

DB_PATH="${DB_PATH:-/data/filament.db}"
DB_DIR="$(dirname "$DB_PATH")"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DB_DIR"

  # Only touch ownership when it's actually wrong — on a big existing library
  # a recursive chown every boot is wasted work.
  if [ "$(stat -c %u "$DB_DIR")" != "$PUID" ] || [ "$(stat -c %g "$DB_DIR")" != "$PGID" ]; then
    echo "filament-library: taking ownership of $DB_DIR as $PUID:$PGID"
    if ! chown -R "$PUID:$PGID" "$DB_DIR"; then
      echo "filament-library: WARNING could not chown $DB_DIR." >&2
      echo "  If the app fails to start, run this on the host:" >&2
      echo "    sudo chown -R $PUID:$PGID ./data" >&2
    fi
  fi

  exec su-exec "$PUID:$PGID" "$@"
fi

# Already unprivileged (e.g. compose set `user:`) — nothing to fix up.
exec "$@"
