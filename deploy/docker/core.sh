#!/bin/sh
# Course Core on Docker: one command for each operation (see README.md here, or run without
# arguments for the list). It runs deploy/docker/ops.mjs with this machine's Node 22 or later;
# without one it runs the same script in the Course Core image, which has Node, the Docker CLI
# and Compose, with the Docker socket and this checkout mounted.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$DIR/../.." && pwd)

if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
  exec node "$DIR/ops.mjs" "$@"
fi

command -v docker >/dev/null 2>&1 || { echo "core.sh: Docker is required (https://docs.docker.com/engine/install/)." >&2; exit 1; }
env_file=${COURSE_ENV_FILE:-$DIR/.env}
image=$(sed -n 's/^COURSE_CORE_IMAGE=//p' "$env_file" 2>/dev/null | tail -n 1)
image=${image:-course-core-selfhost:local}
if ! docker image inspect "$image" >/dev/null 2>&1; then
  case "$image" in
    */*) docker pull "$image" ;;
    # Building needs only Docker; the two secrets are not used by a build.
    *) POSTGRES_PASSWORD=build SUPERVISOR_HOST_TOKEN=build docker compose -f "$DIR/compose.yaml" --env-file /dev/null build api ;;
  esac
fi
socket=/var/run/docker.sock
case "${DOCKER_HOST:-}" in unix://*) socket=${DOCKER_HOST#unix://} ;; esac
tty=""
[ -t 0 ] && tty="-t"
# Root in this short-lived container only, to reach the Docker socket; files it writes are given
# back to the user who ran core.sh.
exec docker run --rm -i $tty --user 0:0 --network host \
  -e COURSE_OPS_OWNER="$(id -u):$(id -g)" -e COMPOSE_PROJECT_NAME -e COURSE_ENV_FILE \
  -v "$socket:/var/run/docker.sock" -v "$ROOT:$ROOT" -w "$ROOT" \
  --entrypoint node "$image" "$DIR/ops.mjs" "$@"
