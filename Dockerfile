# The hosted planner's image (docs/deploy.md).
#
#   docker build --target runtime -t pkp-planner .   # no data inside: mount the bundle at /data (the compose example)
#   docker build -t pkp-planner-data .               # the default target, with-data: the bundle baked in at /data
#
# The with-data target needs `npm run bundle` first (dist/bundle/pkp-data/). An image holding the data carries the
# game's data and sprites: build it on your own machine or your host, and never push it to a public registry.
#
# Run it read-only, with no capabilities and no writable volume:
#   docker run --read-only --cap-drop ALL -p 8080:8080 pkp-planner-data

ARG NODE_IMAGE=node:22-bookworm-slim

# The build and deps stages run on the building machine's own platform ($BUILDPLATFORM) and only the runtime stage on the
# target's, since everything they hand on is plain JavaScript: so an arm64 image (an Arm VM) builds on an
# x86 PC without emulation (`docker buildx build --platform linux/arm64 …`), and natively on the VM itself.

# 1. build: the page (vite) and the server (tsc), with the dev dependencies.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build:web && npm run build:server

# 2. deps: the run-time dependencies alone. pokemon-showdown's optional ones (its own server's sqlite, pg, mail and
# websocket extras) are never loaded by the simulator the planner uses, so they stay out. They must stay plain
# JavaScript, as they are installed for the building machine's platform: a native addon fails the build here.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund \
 && if find node_modules -name '*.node' | grep .; then echo 'A run-time dependency ships a native addon: build the deps stage for the target platform' >&2; exit 1; fi

# 3. runtime: plain node over the compiled server, no data. Mount the bundle at /data.
FROM ${NODE_IMAGE} AS runtime
ARG PKP_VERSION=dev
# The heap: Node sizes it from the container's memory limit, about 524 MB under compose's 1 GB, which is below the
# server's budget (about 320 MB base, plus up to 256 MB of sessions). 768 MB leaves about 250 MB of a 1 GB limit for the
# rest of the process. With a larger limit, raise it to the limit less about 250 MB.
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=768 \
    PKP_MODE=hosted \
    PKP_DATA=/data \
    PKP_STATIC=/app/dist/web \
    PORT=8080 \
    PKP_VERSION=${PKP_VERSION}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist/web ./dist/web
COPY --from=build /app/dist/server ./dist/server
COPY package.json ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server/server/main.js"]

# 4. with-data (the default target): the runtime with the bundle baked in at /data.
FROM runtime AS with-data
COPY --chown=node:node dist/bundle/pkp-data /data
