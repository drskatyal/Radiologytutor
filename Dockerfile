# FlowRad Learn — production image (Next.js standalone).
# Used by Fly.io (fly.toml) and Cloud Run (deploy/gcp). Same image.
# Requires `output: "standalone"` in next.config.mjs (already set).
# Cloud Run sets PORT at runtime (8080); the server honors it.
#
# Multi-stage so the runner has no npm, no source, no secrets.
# Do NOT run the Next build with --turbo (Cornerstone wasm needs webpack).

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

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
