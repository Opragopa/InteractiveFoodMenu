# Local Firebase backend: Functions, Authentication, Firestore and Storage emulators.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y openjdk-17-jre-headless ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/app

# Install dependencies before copying sources so Docker can reuse this layer.
COPY package.json package-lock.json ./
COPY functions/package.json functions/package-lock.json ./functions/
RUN npm ci && npm --prefix functions ci

COPY firebase.json firestore.rules firestore.indexes.json storage.rules .firebaserc ./
COPY functions ./functions
COPY docker/firebase-entrypoint.sh /usr/local/bin/firebase-entrypoint

RUN npm --prefix functions run build \
    && chmod 755 /usr/local/bin/firebase-entrypoint \
    && chown -R node:node /srv/app

USER node

ENV FIREBASE_PROJECT_ID=interactivefoodmenu \
    ENFORCE_APP_CHECK=false

VOLUME ["/srv/app/.firebase-data"]

EXPOSE 4000 5001 8080 9099 9199

ENTRYPOINT ["/usr/local/bin/firebase-entrypoint"]
