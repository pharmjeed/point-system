# syntax=docker/dockerfile:1
# WhatsApp simulator (dev/test only — refuses to start with APP_ENV/NODE_ENV=production).
# Build context: tools/wa-simulator (infra/compose: `build: ../../tools/wa-simulator`).
# The base image is overridable for registry mirrors: --build-arg NODE_IMAGE=mirror.gcr.io/library/node:24-alpine
ARG NODE_IMAGE=node:24-alpine

# ---- build: compile TypeScript ----
FROM ${NODE_IMAGE} AS build
WORKDIR /build
# Same compiler as the monorepo (root devDependency typescript7 → typescript@7.0.2) and the root @types/node.
RUN npm install --no-save --no-audit --no-fund --loglevel=error typescript@7.0.2 @types/node@26.6.5
# package.json carries "type": "module" (ESM output under module nodenext).
COPY package.json tsconfig.docker.json ./
COPY src ./src
RUN npx tsc -p tsconfig.docker.json

# ---- runtime: no dependencies besides Node itself ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=development \
    PORT=4010
WORKDIR /app
COPY package.json ./
COPY fixtures ./fixtures
COPY scenarios ./scenarios
COPY --from=build /build/dist ./dist
USER node
EXPOSE 4010
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/_sim/health" > /dev/null || exit 1
CMD ["node", "dist/main.js"]
