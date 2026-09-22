FROM node:22-bookworm-slim AS build
WORKDIR /srv/api
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /srv/api
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /srv/api/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
