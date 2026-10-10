#!/bin/sh
set -eu
java -jar /app/app.jar &
backend_pid=$!
node /app/server.js &
gateway_pid=$!
shutdown() { kill "$backend_pid" "$gateway_pid" 2>/dev/null || true; }
trap 'shutdown; exit 0' INT TERM
while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$gateway_pid" 2>/dev/null; do sleep 2; done
shutdown
wait "$backend_pid" || exit $?
wait "$gateway_pid"
