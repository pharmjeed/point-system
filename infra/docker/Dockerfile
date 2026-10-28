# Backend image «point-backend»: one image, three uses (05 §3, §11.2; docs/DEPLOYMENT.md)
#   api      node api/dist/main.js                              (default command; API_PORT, metrics on METRICS_PORT)
#   worker   node worker/dist/main.js                           (metrics on METRICS_PORT + 1)
#   tools    node db/dist/cli.js migrate | invariants           (migrations: the one-shot before every rollout)
#            node api/dist/cli.js create-owner --phone … --name …
# Build from the repository root:
#   docker build -f infra/docker/Dockerfile -t point-backend:$(git rev-parse --short HEAD) .
# Behind a TLS-inspecting proxy, hand the build its CA as a secret (it never ends up in a layer):
#   docker build --secret id=build_ca,src=/path/to/ca.pem -f infra/docker/Dockerfile .
# NODE_IMAGE may point at a mirror of the official image (same major: Node.js 24 LTS, 05 §2).
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm is the version pinned in package.json (packageManager), through corepack
RUN corepack enable
# manifests first: the dependency layer is rebuilt only when a manifest or the lockfile changes
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/server/package.json packages/server/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN --mount=type=secret,id=build_ca,required=false \
    --mount=type=cache,id=point-pnpm-store,target=/root/.local/share/pnpm/store \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    pnpm install --frozen-lockfile --filter '@point/api...' --filter '@point/worker...' --filter '@point/db...'
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
RUN pnpm --filter '@point/api...' --filter '@point/worker...' build
# self-contained folders with production dependencies only (workspace packages are copied, not linked);
# the TypeScript sources and tests of the workspace packages are not shipped
RUN --mount=type=secret,id=build_ca,required=false \
    --mount=type=cache,id=point-pnpm-store,target=/root/.local/share/pnpm/store \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    pnpm --filter @point/api deploy --prod /out/api \
 && pnpm --filter @point/worker deploy --prod /out/worker \
 && pnpm --filter @point/db deploy --prod /out/db \
 && for d in /out/*; do \
      rm -rf "$d/src" "$d/test" "$d"/tsconfig*.json "$d/scripts" "$d/drizzle.config.ts"; \
      for p in "$d"/node_modules/.pnpm/@point+*/node_modules/@point/*; do \
        rm -rf "$p/src" "$p/test" "$p"/tsconfig*.json "$p/scripts" "$p/drizzle.config.ts"; \
      done; \
    done

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production TZ=UTC
WORKDIR /app
# code and dependencies belong to root and are read-only for the process user
COPY --from=build /out/api ./api
COPY --from=build /out/worker ./worker
COPY --from=build /out/db ./db
# db/dist resolves docs/06_schema.sql and the invariants script at /docs (db:invariants after a restore)
COPY docs/06_schema.sql docs/06_schema_invariants_test.sql /docs/
# the unprivileged user of the official Node.js images (uid 1000)
USER node
EXPOSE 3000 9464 9465
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "api/dist/main.js"]
