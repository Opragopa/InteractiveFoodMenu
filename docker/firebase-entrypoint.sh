#!/bin/sh
set -eu

DATA_DIR=/srv/app/.firebase-data
mkdir -p "$DATA_DIR"

set -- /srv/app/node_modules/.bin/firebase emulators:start \
  --project "${FIREBASE_PROJECT_ID}" \
  --only auth,firestore,functions,storage

# Firebase rejects an empty import directory. A new named volume is empty on
# its first run, so import only after it contains a previous emulator export.
if [ -f "$DATA_DIR/firebase-export-metadata.json" ]; then
  set -- "$@" --import="$DATA_DIR"
else
  echo "No previous Firebase emulator data found; starting with an empty backend."
fi

exec "$@" --export-on-exit="$DATA_DIR"
