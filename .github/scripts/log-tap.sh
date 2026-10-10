#!/usr/bin/env bash
# Capture dev-stack service logs across container recreations and restarts (CI dev-stack-smoke
# job: step-9 push gate, docs/plans/step-9.md 9.16; data-export gate, docs/plans/review-fixes.md
# 2.14).
#
# `docker compose logs` only shows the current containers, and the push gate recreates api and
# worker twice (with no push debounce, then back to the stack default in its `finally`), so a
# scan after the gate would only see the restored containers' start-up output. This follows every
# container of the given services that runs while the tap is on, polling once a second, and writes
# each one's full log (`docker logs -f --timestamps`) to <dir>/<service>-<id>.log, so the scan
# sees everything the gate made the services print.
#
# Restarts: `docker compose restart api` (restart-api.sh, which the export gate calls) keeps the
# container id, and `docker logs -f` exits when its container stops. A container whose follower
# has ended is therefore followed again once it is running, rewriting its file with a full replay
# (the daemon keeps a container's log across restarts, so nothing from before or after the
# restart is lost and nothing is duplicated).
#
#   bash .github/scripts/log-tap.sh start <dir> [service...]   (default services: api worker)
#   ... run the gate ...
#   bash .github/scripts/log-tap.sh stop <dir>
#
# Run from the repo root (docker-compose.dev.yml). `stop` is safe to call twice or without a
# `start`. The files hold raw service logs: scan them, do not upload them.
set -euo pipefail

DC=(docker compose -f docker-compose.dev.yml)

usage() {
  echo "usage: log-tap.sh start <dir> [service...] | stop <dir>" >&2
  exit 2
}

cmd="${1:-}"
dir="${2:-}"
[ -n "$cmd" ] && [ -n "$dir" ] || usage
shift 2

case "$cmd" in
  start)
    [ "$#" -gt 0 ] || set -- api worker
    mkdir -p "$dir"
    if [ -f "$dir/watcher.pid" ] && kill -0 "$(cat "$dir/watcher.pid")" 2>/dev/null; then
      echo "::error::a log tap is already running for $dir"
      exit 1
    fi
    : >"$dir/seen"
    : >"$dir/pids"
    # Detached watcher; its stdout/stderr go to a file so the CI step does not wait on them.
    nohup bash "$0" _watch "$dir" "$@" >"$dir/watcher.out" 2>&1 &
    echo $! >"$dir/watcher.pid"
    # Wait until every named service has a followed container (they are running already).
    for _ in $(seq 1 30); do
      [ "$(grep -c . "$dir/seen" || true)" -ge "$#" ] && {
        echo "log tap started for: $* -> $dir"
        exit 0
      }
      sleep 1
    done
    cat "$dir/watcher.out" || true
    echo "::error::log tap did not attach to all of: $*"
    exit 1
    ;;

  _watch)
    trap 'exit 0' TERM INT
    while :; do
      # Running containers only: `docker logs -f` on a container that is still "created"
      # returns at once with nothing, and it would then never be followed again. A running
      # container's log is replayed from its start, so attaching a second late loses nothing.
      ids="$("${DC[@]}" ps -q --status running "$@" 2>/dev/null || true)"
      for id in $ids; do
        pf="$dir/follow-${id:0:12}.pid"
        # Already followed and the follower is alive: nothing to do.
        if [ -f "$pf" ] && kill -0 "$(cat "$pf")" 2>/dev/null; then
          continue
        fi
        # New container, or a restarted one whose follower ended: (re)write its file with the
        # full log so far and keep following.
        svc="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id" 2>/dev/null || echo unknown)"
        docker logs -f --timestamps "$id" >"$dir/$svc-${id:0:12}.log" 2>&1 &
        echo $! >"$pf"
        echo $! >>"$dir/pids"
        grep -qxF "$id" "$dir/seen" || echo "$id" >>"$dir/seen"
      done
      sleep 1
    done
    ;;

  stop)
    [ -d "$dir" ] || exit 0
    if [ -f "$dir/watcher.pid" ]; then
      kill "$(cat "$dir/watcher.pid")" 2>/dev/null || true
      rm -f "$dir/watcher.pid"
    fi
    # Let the followers drain what the daemon has buffered, then end them (live containers keep
    # `docker logs -f` open forever; those of removed containers have exited already).
    sleep 2
    if [ -f "$dir/pids" ]; then
      while read -r pid; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
      done <"$dir/pids"
    fi
    n="$(find "$dir" -name '*.log' | wc -l | tr -d ' ')"
    echo "log tap stopped: $n container log file(s) in $dir"
    ;;

  *) usage ;;
esac
