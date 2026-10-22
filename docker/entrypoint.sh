#!/bin/sh
# Container entrypoint: runs the server as PUID:PGID so files in the data directory belong to the
# user the host expects, e.g. 99:100 (nobody:users) on unRAID. Defaults to 1000:1000, the image's
# `node` user, which is what earlier images ran as, so existing volumes keep working unchanged.
#
#   PUID, PGID  numeric user and group to run as (default 1000)
#   UMASK       optional, e.g. 022 or 002, for files the server creates
#
# Started with `--user` (or `user:` in Compose) the container is already unprivileged: the caller
# chose the user, so PUID/PGID are ignored and nothing is chowned.
set -eu

fail() {
  echo "ratatoskr: $*" >&2
  exit 1
}

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

puid="${PUID:-1000}"
pgid="${PGID:-1000}"
case "$puid" in '' | *[!0-9]*) fail "PUID must be a numeric user id, got '$puid'" ;; esac
case "$pgid" in '' | *[!0-9]*) fail "PGID must be a numeric group id, got '$pgid'" ;; esac

if [ -n "${UMASK:-}" ]; then
  case "$UMASK" in *[!0-7]*) fail "UMASK must be octal, e.g. 022, got '$UMASK'" ;; esac
  umask "$UMASK"
fi

# Hand the data directory over when anything in it belongs to someone else, e.g. a fresh unRAID
# appdata folder, a volume written by an older image, or after changing PUID/PGID.
data_dir="${RATATOSKR_DATA_DIR:-/data}"
mkdir -p "$data_dir"
if [ -n "$(find "$data_dir" \( ! -user "$puid" -o ! -group "$pgid" \) | head -n 1)" ]; then
  chown -R "$puid:$pgid" "$data_dir"
fi

exec su-exec "$puid:$pgid" "$@"
