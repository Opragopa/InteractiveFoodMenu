#!/bin/sh
set -eu

mkdir -p /srv/app/.firebase-data

exec /srv/app/node_modules/.bin/firebase emulators:start \
  --project "${FIREBASE_PROJECT_ID}" \
  --only auth,firestore,functions,storage \
  --import=/srv/app/.firebase-data \
  --export-on-exit=/srv/app/.firebase-data
