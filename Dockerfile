# FlowRad Learn — production image (Next.js standalone).
# Used by Fly.io (fly.toml) and Cloud Run (deploy/gcp). Same image.
# Requires `output: "standalone"` in next.config.mjs (already set).
# Cloud Run sets PORT at runtime (8080); the server honors it.
#
# Multi-stage so the runner has no source and no secrets.
# Do NOT run the Next build with --turbo (Cornerstone wasm needs webpack).
#
# START COMMAND: `node server.js`. `next start` is NOT usable against
# standalone output — the traced node_modules has no `.bin/next` — so a
# platform configured to start the app with `npm start` crash-loops on
# `sh: 1: next: not found`. Railway's builder + start command are pinned in
# railway.json; the runner also rewrites the standalone package.json's `start`
# script below so `npm start` boots the same server instead of failing.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Offline voice commands: the small speech model (Apache-2.0, ~40 MB), checked
# against scripts/voice-model.sha256. Its own stage, keyed only on the fetch
# script and the pinned hash, so Docker caches it across deploys. public/voice/
# is not in the repository: without this the live viewer had no model and the
# mic could never start. A checksum mismatch (or any other failure) fails the
# build; only a network outage (exit 3) is tolerated, and prod-smoke's voice
# check then fails loudly on the missing model.
FROM python:3.12-slim AS voice
WORKDIR /app
COPY scripts/fetch-voice-model.py scripts/voice-model.sha256 ./scripts/
RUN mkdir -p public/voice desktop/public/voice; \
  rc=0; python3 scripts/fetch-voice-model.py || rc=$?; \
  if [ "$rc" = "3" ]; then echo "WARNING: voice model host unreachable; voice commands will say they are not included in this build"; \
  elif [ "$rc" != "0" ]; then exit "$rc"; \
  else python3 scripts/fetch-voice-model.py --check; fi

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build
# Carry the LIVE build's /_next/static files into this image (kept 7 days
# after they stop being current), so tabs opened before this deploy can still
# load their lazy chunks. Best effort; see scripts/carry-static.mjs. Railway
# passes RAILWAY_PUBLIC_DOMAIN to the build; STATIC_CARRY_FROM overrides it.
ARG STATIC_CARRY_FROM=""
ARG RAILWAY_PUBLIC_DOMAIN=""
RUN node scripts/carry-static.mjs --from "${STATIC_CARRY_FROM:-${RAILWAY_PUBLIC_DOMAIN:+https://$RAILWAY_PUBLIC_DOMAIN}}" || true

FROM node:20-bookworm-slim AS runner
WORKDIR /app
# The commit this image was built from; /api/version reports it.
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=voice --chown=nextjs:nodejs /app/public/voice ./public/voice
# Standalone trace: server.js + traced node_modules at the image root.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Next copies the project package.json into the standalone output verbatim, so
# its `start` script is `next start` — a binary that does not exist in this
# image. Point it at the server we actually ship.
RUN node -e "const fs=require('fs'),f='/app/package.json',p=JSON.parse(fs.readFileSync(f,'utf8'));p.scripts={start:'node server.js'};fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')"

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
