# Local Firebase backend: Functions, Authentication, Firestore and Storage emulators.
# Build stage keeps TypeScript tooling out of the final runtime image.
FROM node:22-bookworm-slim AS build

WORKDIR /srv/app

# Keep the Firebase CLI install layer reusable while application source changes.
COPY package.json package-lock.json ./
COPY functions/package.json functions/package-lock.json ./functions/
RUN npm ci && npm --prefix functions ci

COPY firebase.json firestore.rules firestore.indexes.json storage.rules .firebaserc ./
COPY functions ./functions
RUN npm --prefix functions run build \
    && npm --prefix functions prune --omit=dev

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y openjdk-17-jre-headless ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/app

COPY --from=build /srv/app/package.json /srv/app/package-lock.json ./
COPY --from=build /srv/app/node_modules ./node_modules
COPY --from=build /srv/app/functions ./functions
COPY --from=build /srv/app/firebase.json /srv/app/firestore.rules /srv/app/firestore.indexes.json /srv/app/storage.rules /srv/app/.firebaserc ./
COPY docker/firebase-entrypoint.sh /usr/local/bin/firebase-entrypoint

# Firebase normally downloads these on the first container start. Caching them
# in the image makes restarts fast and makes startup failures visible promptly.
ENV FIREBASE_EMULATORS_PATH=/opt/firebase/emulators
RUN /srv/app/node_modules/.bin/firebase setup:emulators:firestore \
    && /srv/app/node_modules/.bin/firebase setup:emulators:storage \
    && /srv/app/node_modules/.bin/firebase setup:emulators:ui \
    && chmod 755 /usr/local/bin/firebase-entrypoint \
    && chown -R node:node /srv/app /opt/firebase

USER node

ENV FIREBASE_PROJECT_ID=interactivefoodmenu \
    ENFORCE_APP_CHECK=false

EXPOSE 4000 5001 8080 9099 9199

ENTRYPOINT ["/usr/local/bin/firebase-entrypoint"]
