# Web image «point-web»: the PWA (apps/web/dist) served by Caddy, which is also the reverse proxy and the TLS
# endpoint of the single origin (infra/caddy/Caddyfile, DEC-29, DEC-94). VITE_* values are public and are baked
# in at build time (05 §7.7): never pass a secret as a build argument.
#   docker build -f infra/docker/web.Dockerfile -t point-web:$(git rev-parse --short HEAD) \
#     --build-arg VITE_VAPID_PUBLIC_KEY=<public key> --build-arg VITE_APP_VERSION=$(git rev-parse --short HEAD) .
# Behind a TLS-inspecting proxy: --secret id=build_ca,src=/path/to/ca.pem (see infra/docker/Dockerfile).
ARG NODE_IMAGE=node:24-alpine
ARG CADDY_IMAGE=caddy:2.11-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=secret,id=build_ca,required=false \
    --mount=type=cache,id=point-pnpm-store,target=/root/.local/share/pnpm/store \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    pnpm install --frozen-lockfile --filter '@point/web...' --filter '@point/shared...'
COPY brand ./brand
# the canon zod schemas are bundled from their sources (vite alias @shared, apps/web/vite.config.ts)
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
ARG VITE_API_BASE_URL=
ARG VITE_WS_PATH=/ws
ARG VITE_VAPID_PUBLIC_KEY=
ARG VITE_BRAND_STAFF_NAME_AR=
ARG VITE_BRAND_STAFF_NAME_EN=
ARG VITE_BRAND_CUSTOMER_NAME_AR=
ARG VITE_APP_VERSION=dev
# the bundle only (`vite build`): type-checking, which also covers the tests and e2e that import other workspace
# packages, is CI's job. The CSP allows no inline script (script-src 'self'): the built shell must not contain one
RUN pnpm --filter @point/web exec vite build \
 && test -f apps/web/dist/index.html \
 && if grep -Eq '<script>|<script( [a-z-]+="[^"]*")*>[^<]' apps/web/dist/index.html; then \
      echo 'inline <script> in index.html (CSP script-src self)'; exit 1; fi

FROM ${CADDY_IMAGE} AS runtime
COPY --from=build /repo/apps/web/dist /srv
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY infra/caddy/conf.d/00-site.caddy /etc/caddy/conf.d/00-site.caddy
