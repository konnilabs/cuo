FROM golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS go-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /cuo ./cmd/cuo
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
ENV CUO_DATA=/data
ENTRYPOINT ["cuo","agent"]
