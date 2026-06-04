# syntax=docker/dockerfile:1.7

# ─── Builder ──────────────────────────────────────────────────────────────────
FROM node:20-bookworm AS builder

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma

# Stub DATABASE_URL so prisma.config.ts's env() resolver doesn't error during
# the postinstall `prisma generate`. No connection is made at build time.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"

RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN npm run build

RUN npm prune --omit=dev

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# Commit count from the build host. Baked into the runtime image as the
# patch number for the sidebar version display, since the runtime has no
# .git directory for `git rev-list --count HEAD` to inspect. Defaults to
# "0" so a local `docker build` without --build-arg still produces a
# usable image (version will read as <minor>.0).
ARG POLARIS_BUILD_COMMIT_COUNT=0

ENV NODE_ENV=production \
    PORT=3000 \
    POLARIS_STATE_DIR=/app/state \
    POLARIS_BUILD_COMMIT_COUNT=${POLARIS_BUILD_COMMIT_COUNT}

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-client \
      iputils-ping \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

# Install Go 1.22+ for the Polaris Agent build feature (Server Settings →
# Maintenance → Polaris Agent → Build). bookworm-slim ships golang 1.21.x
# which is too old for agent/go.mod; bookworm-backports has 1.22+.
# Image size grows from ~50 MB to ~350 MB (one-time hit, not per-tag).
RUN echo "deb http://deb.debian.org/debian bookworm-backports main" \
      > /etc/apt/sources.list.d/backports.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends -t bookworm-backports \
      golang-go \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY public ./public
# Polaris Agent Go source — the in-app build feature (Server Settings →
# Maintenance → Polaris Agent → Build) shells out to `go build` against
# this directory. Without it, agentBuildService throws "agent/ source
# directory not found" before the first compiler invocation. Source-only;
# no compiled binaries are baked into the image — operators click Build
# on the running container to produce the per-platform agent binaries
# under /app/state/data/agents/<version>/.
COPY agent ./agent

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /app/state/data/backups /app/state/public/uploads /app/state/data/agents /app/state/.cache/go-build
# /app/state/data/agents holds Polaris Agent binaries (per-version subdir
# + manifest.json). With Go now pre-installed in the image, operators
# can click Build agent binaries on Server Settings → Maintenance and
# the binaries land here automatically. The directory is still empty
# at boot — the install path surfaces a clear "no binaries available"
# error until the first Build click completes.
#
# /app/state/.cache/go-build is the GOCACHE the build subprocess uses
# (HOME=/app/state is set when the build runs). Pre-creating keeps the
# first build from racing on mkdir.

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
