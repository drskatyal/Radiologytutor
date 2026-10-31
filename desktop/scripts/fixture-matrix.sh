#!/usr/bin/env bash
# Open every fixture source in the real app and require a painted first image.
#   python3 desktop/scripts/make-fixtures.py /tmp/fixtures
#   xvfb-run -a desktop/scripts/fixture-matrix.sh desktop/src-tauri/target/debug/radlearn-viewer /tmp/fixtures
set -u
BIN="$1"; F="$2"; ok=0; fail=0
for p in "$F"/ts/* "$F/multiframe" "$F/cd-media" "$F/cd-media/DICOMDIR" "$F/archives/study.zip" "$F/real" "$F/pet-phantom" "$F/mr-brain" "$F/ct-phantom"; do
  out=$(RADLEARN_BENCH=1 RADLEARN_BENCH_EXIT=1 timeout 60 "$BIN" "$p" 2>/dev/null | grep '^RADLEARN_BENCH ' || true)
  if [ -n "$out" ]; then ok=$((ok+1)); echo "OK   ${p#$F/}"; else fail=$((fail+1)); echo "FAIL ${p#$F/}"; fi
done
echo "ok=$ok fail=$fail"
[ "$fail" -eq 0 ]
