# syntax=docker/dockerfile:1
# Payment simulator (the Moyasar API; dev, tests, CI and the staging stack of infra/deploy/install.sh only — it refuses
# to start with APP_ENV/NODE_ENV=production and refuses any live key, DEC-510, DEC-630).
# Build context: tools/payment-simulator (infra/compose: `build: ../../tools/payment-simulator`).
# The base image is overridable for registry mirrors: --build-arg NODE_IMAGE=mirror.gcr.io/library/node:24-alpine
# Behind a TLS-inspecting proxy: --secret id=build_ca,src=<ca.pem> (never stored in a layer).
ARG NODE_IMAGE=node:24-alpine

# ---- build: compile TypeScript ----
FROM ${NODE_IMAGE} AS build
WORKDIR /build
# Same compiler as the monorepo (root devDependency typescript7 → typescript@7.0.2) and the root @types/node.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm install --no-save --no-audit --no-fund --loglevel=error typescript@7.0.2 @types/node@26.6.5
# package.json carries "type": "module" (ESM output under module nodenext).
COPY package.json tsconfig.docker.json ./
COPY src ./src
RUN npx tsc -p tsconfig.docker.json

# ---- runtime: no dependencies besides Node itself ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=development \
    PORT=4020
WORKDIR /app
COPY package.json ./
COPY --from=build /build/dist ./dist
USER node
EXPOSE 4020
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/_sim/health" > /dev/null || exit 1
CMD ["node", "dist/main.js"]
