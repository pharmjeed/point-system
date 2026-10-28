# One backend image, two commands (05 §3): `node apps/api/dist/main.js` or `node apps/worker/dist/main.js`.
# Build from the repository root:  docker build -f infra/docker/Dockerfile -t point-backend .
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY docs/06_schema.sql docs/06_schema_invariants_test.sql ./docs/
RUN pnpm install --frozen-lockfile --filter '@point/api...' --filter '@point/worker...' --filter '@point/db...'
RUN pnpm --filter '@point/shared' --filter '@point/db' --filter '@point/server' --filter '@point/api' --filter '@point/worker' build
RUN pnpm deploy --filter @point/api --prod /out/api && pnpm deploy --filter @point/worker --prod /out/worker && pnpm deploy --filter @point/db --prod /out/db

FROM node:24-alpine AS runtime
ENV NODE_ENV=production TZ=UTC
WORKDIR /app
RUN addgroup -S point && adduser -S point -G point
COPY --from=build /out/api ./api
COPY --from=build /out/worker ./worker
COPY --from=build /out/db ./db
COPY --from=build /repo/docs /docs
USER point
EXPOSE 3000 9464
# default: api. Override with: node worker/dist/main.js  |  node db/dist/cli.js migrate
CMD ["node", "api/dist/main.js"]
