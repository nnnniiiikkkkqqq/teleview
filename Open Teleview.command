#!/bin/zsh

cd "${0:A:h}" || exit 1

node server.mjs &
teleview_server_pid=$!

trap 'kill "$teleview_server_pid" 2>/dev/null' EXIT INT TERM
sleep 1
open "http://127.0.0.1:4173"
wait "$teleview_server_pid"
