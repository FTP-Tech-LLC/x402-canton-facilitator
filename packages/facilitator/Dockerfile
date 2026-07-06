#
# Canton x402 facilitator — production image.
#
# Two-stage build:
#   1. `build` — installs all workspace deps (pnpm) and builds the
#      `@ftptech/x402-canton-core`, `@ftptech/x402-canton-ledger`, and
#      `@ftptech/x402-canton-facilitator` packages from source.
#   2. `runtime` — minimal Alpine image with just the production
#      install + the compiled dist. Non-root user.
#
# Build context MUST be the repo root (so the monorepo is visible to
# pnpm). Build from there:
#
#   docker build -f packages/facilitator/Dockerfile -t canton-x402-facilitator .
#
# Run with the env vars documented in packages/facilitator/README.md:
#
#   docker run --rm -p 4022:4022 \
#     -e CANTON_NETWORK=canton:devnet \
#     -e CANTON_PARTICIPANT_URL=... \
#     -e CANTON_FACILITATOR_PARTY=... \
#     -e CANTON_SYNCHRONIZER_ID=... \
#     -e CANTON_SCAN_URL=... \
#     -e DATABASE_URL=postgres://... \
#     -e JWT_ISSUER=oidc \
#     -e OIDC_TOKEN_ENDPOINT=... \
#     -e OIDC_CLIENT_ID=... \
#     -e OIDC_CLIENT_SECRET=... \
#     -e LEDGER_API_AUDIENCE=... \
#     canton-x402-facilitator

# ────────────────────────────── build stage ──────────────────────────────
FROM node:22-alpine AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Workspace manifest + lockfile first for cache efficiency.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json    packages/core/package.json
COPY packages/ledger/package.json  packages/ledger/package.json
COPY packages/facilitator/package.json packages/facilitator/package.json
COPY packages/client/package.json  packages/client/package.json
COPY packages/express/package.json packages/express/package.json
COPY packages/next/package.json    packages/next/package.json

RUN pnpm install --frozen-lockfile \
      --filter @ftptech/x402-canton-core... \
      --filter @ftptech/x402-canton-ledger... \
      --filter @ftptech/x402-canton-facilitator...

# Sources for the three packages the facilitator transitively depends on.
COPY packages/core    packages/core
COPY packages/ledger  packages/ledger
COPY packages/facilitator packages/facilitator

RUN pnpm --filter @ftptech/x402-canton-facilitator... build

# ───────────────────────────── runtime stage ─────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# `wget` is needed for HEALTHCHECK; pnpm for postinstall scripts that
# might run on node_modules in this layer. `tini` is the recommended
# minimal init so SIGTERM from `docker stop` reaches node directly
# (Fastify's `closeWithGrace` integration shuts down cleanly).
RUN apk add --no-cache wget tini \
 && corepack enable && corepack prepare pnpm@9.12.0 --activate \
 && addgroup -S facilitator && adduser -S facilitator -G facilitator

# Copy the resolved workspace tree (deps + built dist) for the
# facilitator and its transitive workspace packages.
COPY --from=build --chown=facilitator:facilitator /repo /app

USER facilitator
WORKDIR /app/packages/facilitator

ENV NODE_ENV=production
EXPOSE 4022

# Docker HEALTHCHECK — hits the facilitator's /ready endpoint every 30s.
# /ready (unlike the static /health liveness literal) verifies the facilitator
# can actually SETTLE: a mintable ledger token + a reachable participant +
# reachable Scan DSO-state. It returns 200 {"ready":true,...} when healthy and
# 503 {"ready":false,...} (with a per-dep breakdown) otherwise, so the container
# is reported unhealthy precisely when settle is impossible — not merely when the
# process is down. A run of three consecutive failures flips the container to
# unhealthy, which docker-compose / orchestrators use to gate traffic + restart.
# `wget -q -O -` exits non-zero on the 503; the grep guards against a stray 200
# body that is not actually ready. Longer start-period/timeout than /health gave
# the readiness checks (token mint + participant + Scan) room on a cold start.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT:-4022}/ready" \
        | grep -q '"ready":true' || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
