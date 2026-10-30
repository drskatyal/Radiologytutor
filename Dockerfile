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

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
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
