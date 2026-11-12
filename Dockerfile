# RadLearn production image for GCP Cloud Run. No deployment happens here.
# Runtime secrets are injected by Cloud Run; never pass them as build arguments.
# Do not use --turbo: Cornerstone workers/WASM require the webpack build.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Source allowlist; no local config, credential directories, test results or data.
COPY package.json package-lock.json next.config.mjs postcss.config.mjs tailwind.config.ts tsconfig.json middleware.ts ./
COPY app ./app
COPY components ./components
COPY lib ./lib
COPY packages ./packages
COPY public ./public
COPY seed ./seed
COPY scripts/build-voice-worker.mjs scripts/voiceWorkerPatch.mjs scripts/build-runtime-env.mjs scripts/startup-check.cjs ./scripts/
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# Runtime validation is compiled by postbuild, not executed with build-time env.
RUN npm run build
# No live-site asset carry or model download. Optional offline speech models must
# already be supplied as reviewed public assets; the worker is generated locally.

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --ingroup nodejs nextjs
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# npm start in this image must use the same checked standalone entry point.
RUN node -e "const fs=require('fs'),f='/app/package.json',p=JSON.parse(fs.readFileSync(f,'utf8'));p.scripts={start:'node --require ./runtime/startup-check.cjs server.js'};fs.writeFileSync(f,JSON.stringify(p)+'\n')"
USER nextjs
EXPOSE 8080
CMD ["node", "--require", "./runtime/startup-check.cjs", "server.js"]
