#!/bin/bash
# Temporary (diagnostics): while the bench runs, spindump every new WebContent
# process (root, kernel stackshots: `sample` reads empty call graphs on this
# runner) for 4 s from the moment it appears.
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
    echo "$(date +%T.%N | cut -c1-12) spindump WebContent $pid (#$n)"
    sudo -n spindump "$pid" 4 10 -file "$out/wc-$n-$pid.spindump.txt" > "$out/wc-$n.log" 2>&1 &
  done
  sleep 0.05
done
wait
