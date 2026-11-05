# Self-hosted object storage «point-minio» (docker-compose.minio.yml; DEPLOYMENT.md §4.2, DEC-458): MinIO no longer
# publishes server or client images (minio/minio and minio/mc are gone from Docker Hub), so the server and its
# client `mc` are built here from their published Go sources, pinned to module versions, with the official Go and
# Alpine images only — no third-party binaries. One image for both uses: `minio server` and the `mc` of minio-init
# and of the healthcheck. Multi-architecture by construction (the production server is arm64).
#   docker build -f infra/docker/minio.Dockerfile -t point-minio .
ARG GO_IMAGE=golang:1.26-alpine
ARG RUNTIME_IMAGE=alpine:3.22

FROM ${GO_IMAGE} AS build
# github.com/minio/minio and github.com/minio/mc, as served by the Go module proxy (go.sum-verified)
ARG MINIO_VERSION=v0.0.0-20260212201848-7aac2a2c5b7c
ARG MC_VERSION=v0.0.0-20251106162529-77f82e18b540
ENV CGO_ENABLED=0 GOFLAGS=-trimpath GOTOOLCHAIN=auto
RUN --mount=type=cache,id=point-go-mod,target=/go/pkg/mod \
    --mount=type=cache,id=point-go-build,target=/root/.cache/go-build \
    go install -ldflags '-s -w' "github.com/minio/minio@${MINIO_VERSION}" \
 && go install -ldflags '-s -w' "github.com/minio/mc@${MC_VERSION}" \
 && /go/bin/minio --version && /go/bin/mc --version

FROM ${RUNTIME_IMAGE} AS runtime
RUN apk add --no-cache ca-certificates \
 && addgroup -S minio && adduser -S -G minio -h /home/minio minio \
 && mkdir -p /data && chown minio:minio /data
COPY --from=build /go/bin/minio /go/bin/mc /usr/local/bin/
USER minio
EXPOSE 9000
CMD ["minio", "server", "/data"]
