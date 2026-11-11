FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
WORKDIR /app
RUN npm install --global npm@11.17.0
COPY console/package.json console/xtend.lock.json ./
COPY console/runtime ./runtime
COPY console/tools/setup.mjs console/tools/resolve-framework.mjs ./tools/
RUN node --use-env-proxy tools/setup.mjs
COPY console/src ./src
COPY console/shared ./shared
COPY console/i18n ./i18n
COPY console/components ./components
COPY console/assets ./assets
COPY console/pwa ./pwa
COPY console/brands ./brands
COPY console/tools ./tools
COPY console/server ./server
COPY console/maraca.config.json console/tsconfig.json ./
RUN node tools/build.mjs
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
WORKDIR /app
# Package managers are build tools, not Console runtime dependencies.
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules /opt/yarn-* && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx
RUN mkdir /data && chown node:node /data
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/runtime ./runtime
COPY --from=build /app/.framework/xtend-maraca ./.framework/xtend-maraca
COPY LICENSE NOTICE third_party/XTend-LICENSE /usr/share/licenses/cuo/
COPY console/brands/LICENSES /usr/share/licenses/cuo/product-icons/
USER node
ENV CUO_AUTH_DATA=/data
EXPOSE 8095
CMD ["node","server/index.mjs"]
