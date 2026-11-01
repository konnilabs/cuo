FROM golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS go-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /cuo ./cmd/cuo
FROM golang:1.26.10-alpine3.23@sha256:34414731924cf2263160f0021f5cf6e1807382d85248f7cb419d4187b96d5e43 AS compose-build
RUN apk add --no-cache ca-certificates curl patch
COPY dependencies/compose/compose.lock dependencies/compose/security.patch dependencies/compose/prepare.sh dependencies/compose/collect-licenses.sh /dependency/
RUN . /dependency/compose.lock && \
    curl --fail --location --silent --show-error "https://codeload.github.com/docker/compose/tar.gz/$COMPOSE_REVISION" -o /tmp/compose.tar.gz && \
    sh /dependency/prepare.sh /tmp/compose.tar.gz /compose && rm /tmp/compose.tar.gz
WORKDIR /compose
ENV GOTOOLCHAIN=local CGO_ENABLED=0
RUN --mount=type=cache,id=cuo-compose-go-mod,target=/go/pkg/mod \
    --mount=type=cache,id=cuo-compose-go-build,target=/root/.cache/go-build \
    . /dependency/compose.lock && \
    go mod download && go mod verify && \
    go build -p 2 -mod=readonly -buildvcs=false -trimpath -tags=e2e \
      -ldflags="-w -X github.com/docker/compose/v5/internal.Version=$COMPOSE_VERSION" -o /out/docker-compose ./cmd && \
    printf '%s  go.mod\n%s  go.sum\n' "$COMPOSE_MOD_SHA256" "$COMPOSE_SUM_SHA256" | sha256sum -c - && \
    mkdir -p /out/licenses && sh /dependency/collect-licenses.sh /out/licenses && \
    printf '%s  go.mod\n%s  go.sum\n' "$COMPOSE_MOD_SHA256" "$COMPOSE_SUM_SHA256" | sha256sum -c - && \
    cp LICENSE NOTICE /dependency/compose.lock /dependency/security.patch /out/licenses/ && \
    cp /usr/local/go/LICENSE /out/licenses/Go-LICENSE && \
    go version -m /out/docker-compose > /out/licenses/build-info.txt && \
    cd /out && sha256sum docker-compose > licenses/binary.sha256
FROM alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f AS core
RUN apk add --no-cache ca-certificates tzdata && addgroup -g 10001 cuo && adduser -D -u 10001 -G cuo cuo && mkdir /data && chown cuo:cuo /data
COPY --from=go-build /cuo /usr/local/bin/cuo
COPY LICENSE NOTICE third_party/XTend-LICENSE third_party/Watchtower-LICENSE /usr/share/licenses/cuo/
USER 10001:10001
ENV CUO_DATA=/data
ENTRYPOINT ["cuo"]
FROM docker:29-cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb AS agent
# Updates never build images; omit the unused Buildx plugin and patch OS packages.
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates tzdata && rm -f /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=go-build /cuo /usr/local/bin/cuo
COPY LICENSE NOTICE third_party/XTend-LICENSE third_party/Watchtower-LICENSE /usr/share/licenses/cuo/
COPY --from=compose-build /out/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=compose-build /out/licenses /usr/share/licenses/cuo/compose/
ENV CUO_DATA=/data
ENTRYPOINT ["cuo","agent"]
