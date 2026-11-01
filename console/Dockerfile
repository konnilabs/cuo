FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
WORKDIR /app
RUN npm install --global npm@11.17.0
COPY third_party/xtend-49166cb.tar.gz /third_party/xtend-49166cb.tar.gz
COPY console/package.json ./
COPY console/runtime ./runtime
COPY console/tools/setup.mjs ./tools/setup.mjs
RUN node tools/setup.mjs
COPY console/src ./src
COPY console/components ./components
COPY console/assets ./assets
COPY console/tools ./tools
COPY console/server ./server
COPY console/maraca.config.json console/tsconfig.json ./
RUN node tools/build.mjs
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/runtime ./runtime
COPY --from=build /app/.framework/xtend-maraca ./.framework/xtend-maraca
COPY LICENSE NOTICE third_party/XTend-LICENSE /usr/share/licenses/cuo/
USER node
ENV CUO_AUTH_DATA=/data
EXPOSE 8095
CMD ["node","server/index.mjs"]
