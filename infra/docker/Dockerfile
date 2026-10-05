# syntax=docker/dockerfile:1.7
# One multi-stage file, three runtime targets:  --target api | worker | web
ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages packages
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
RUN npm run build

# Production dependencies only (the API/worker bundles keep third-party packages external)
FROM node:${NODE_VERSION} AS proddeps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages packages
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts -w @orvia/api -w @orvia/worker

FROM node:${NODE_VERSION} AS api
ENV NODE_ENV=production
WORKDIR /repo
RUN addgroup -S orvia && adduser -S orvia -G orvia
COPY --from=proddeps /repo/node_modules node_modules
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY apps/api/package.json apps/api/package.json
COPY package.json .
USER orvia
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:4000/live || exit 1
CMD ["node", "apps/api/dist/main.js"]

FROM node:${NODE_VERSION} AS worker
ENV NODE_ENV=production
WORKDIR /repo
RUN addgroup -S orvia && adduser -S orvia -G orvia
COPY --from=proddeps /repo/node_modules node_modules
COPY --from=build /repo/apps/worker/dist apps/worker/dist
COPY apps/worker/package.json apps/worker/package.json
COPY package.json .
USER orvia
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:4100/live || exit 1
CMD ["node", "apps/worker/dist/main.js"]

FROM node:${NODE_VERSION} AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /repo
RUN addgroup -S orvia && adduser -S orvia -G orvia
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static apps/web/.next/static
COPY --from=build /repo/apps/web/public apps/web/public
USER orvia
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]

# Dev/staging helper image: seeds demo data (never use against production).
FROM deps AS seed
COPY . .
ENV NODE_ENV=development
CMD ["npx", "tsx", "scripts/seed.ts"]
