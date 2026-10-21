# syntax=docker/dockerfile:1
# Course Core self-host image: the API (which also serves the learner and admin web
# exports), the supervisor worker and dispatcher, and the pinned Temporal CLI used for
# the optional supervision services. Build from the repository root:
#   docker compose -f deploy/docker/compose.yaml build
# The base image is pinned by version and digest; update both together.
ARG NODE_IMAGE=node:26.12.0-slim@sha256:e556a144463cc8dc53afe8de6d2fa0db5c132fd39ffa232c17641bd40df2bf11

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY . .
# Locked, script-free installs and builds in dependency order (see build.mjs).
RUN node deploy/docker/build.mjs
# The pinned Temporal CLI, checked against the archive and binary digests in temporal-cli.mjs.
RUN node deploy/local/temporal-cli.mjs install --to /src/.local/bin/temporal

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production LANG=C.UTF-8
WORKDIR /app
COPY --from=build --chown=root:root /src/packages ./packages
COPY --from=build --chown=root:root /src/services ./services
COPY --from=build --chown=root:root /src/apps/learner/dist ./apps/learner/dist
COPY --from=build --chown=root:root /src/apps/admin/dist ./apps/admin/dist
COPY --from=build --chown=root:root /src/.local/bin/temporal /usr/local/bin/temporal
# Application files are root-owned and read-only to the service user; only /data is writable.
RUN mkdir -p /data && chown node:node /data
USER node
ENV LEARNER_WEB_DIR=/app/apps/learner/dist ADMIN_WEB_DIR=/app/apps/admin/dist SANDBOX_STORAGE_DIR=/data/sandboxes
WORKDIR /app/services/api
EXPOSE 4310
CMD ["node", "--max-old-space-size=768", "dist/main.js"]
