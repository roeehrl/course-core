#!/bin/sh
# Simulates a loaded Docker daemon for qualification tests: container creation and
# removal acknowledge late. Every command still runs against the real Docker CLI.
case "$1" in create|rm) sleep "${COURSE_SANDBOX_TEST_DOCKER_DELAY:-0.8}";; esac
exec docker "$@"
