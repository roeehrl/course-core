# syntax=docker/dockerfile:1
# Course Core self-host image: the API (which also serves the learner and admin web
# exports), the supervisor worker and dispatcher, the pinned Temporal CLI for the
# supervision services, the sandbox gate, the Docker CLI the code sandbox drives through
# that gate, and the media tools for exact clips and the frame check. Build from the
# repository root:
#   docker compose -f deploy/docker/compose.yaml build
# Base images are pinned by version and digest; update both together.
ARG NODE_IMAGE=node:26.12.0-slim@sha256:e556a144463cc8dc53afe8de6d2fa0db5c132fd39ffa232c17641bd40df2bf11
ARG DOCKER_CLI_IMAGE=docker:29.5.2-cli@sha256:9ba8e32bfc35a2c7ae2feb1e3241b2778ae21dee80f4dcd31d04e1cfdea86ea2

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY . .
# Locked, script-free installs and builds in dependency order (see build.mjs).
RUN node deploy/docker/build.mjs
# The pinned Temporal CLI, checked against the archive and binary digests in temporal-cli.mjs.
RUN node deploy/local/temporal-cli.mjs install --to /src/.local/bin/temporal

FROM ${NODE_IMAGE} AS runtime
# ffmpeg, ffprobe and rsvg-convert from Debian's signed archive: exact clips and the frame check.
ARG MEDIA_TOOLS=true
RUN if [ "$MEDIA_TOOLS" = true ]; then apt-get update && apt-get install -y --no-install-recommends ffmpeg librsvg2-bin \
      && rm -rf /var/lib/apt/lists/*; fi
ENV NODE_ENV=production LANG=C.UTF-8
WORKDIR /app
COPY --from=build --chown=root:root /src/package.json ./package.json
COPY --from=build --chown=root:root /src/packages ./packages
COPY --from=build --chown=root:root /src/services ./services
COPY --from=build --chown=root:root /src/apps/learner/dist ./apps/learner/dist
COPY --from=build --chown=root:root /src/apps/admin/dist ./apps/admin/dist
COPY --from=build --chown=root:root /src/deploy/docker/api-start.mjs /src/deploy/docker/sandbox-gate.mjs ./deploy/docker/
COPY --from=build --chown=root:root /src/.local/bin/temporal /usr/local/bin/temporal
# The Docker CLI (the code sandbox talks to the sandbox gate with it) and the Compose plugin
# (deploy/docker/core.sh runs its operations in this image when the host has no Node).
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
# Application files are root-owned and read-only to the service user. Writable: /data, the
# sandbox work volume and the in-memory copy of course files.
RUN mkdir -p /data /sandbox-work /run/course-files && chown node:node /data /sandbox-work /run/course-files && chmod 0700 /run/course-files
USER node
ENV LEARNER_WEB_DIR=/app/apps/learner/dist ADMIN_WEB_DIR=/app/apps/admin/dist SANDBOX_STORAGE_DIR=/data/sandboxes
WORKDIR /app/services/api
EXPOSE 4310
CMD ["node", "--max-old-space-size=768", "/app/deploy/docker/api-start.mjs"]
