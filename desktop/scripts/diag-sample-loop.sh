#!/bin/bash
# Temporary (diagnostics): while the bench runs, sample every new WebContent
# process (and the app) with sudo for 5 s from the moment it appears.
# usage: diag-sample-loop.sh <out dir> <seconds to watch>
out="$1"
until=$(( $(date +%s) + ${2:-60} ))
mkdir -p "$out"
seen=" $(pgrep -f com.apple.WebKit.WebContent | tr '\n' ' ') "
n=0
while [ "$(date +%s)" -lt "$until" ]; do
  for pid in $(pgrep -f com.apple.WebKit.WebContent); do
    case "$seen" in *" $pid "*) continue ;; esac
    seen="$seen$pid "
    n=$((n + 1))
    app=$(pgrep -n flowrad-viewer)
    echo "$(date +%T.%N | cut -c1-12) sampling WebContent $pid and app $app (#$n)"
    sudo -n sample "$pid" 5 1 -mayDie -file "$out/wc-$n-$pid.txt" > /dev/null 2>&1 &
    [ -n "$app" ] && sudo -n sample "$app" 5 1 -mayDie -file "$out/app-$n-$app.txt" > /dev/null 2>&1 &
  done
  sleep 0.05
done
wait
