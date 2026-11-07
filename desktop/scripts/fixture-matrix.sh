#!/usr/bin/env bash
# Open every fixture source in the real app and require a painted first image
# whose on-screen pixels are not blank (unless the image itself is flat).
#   python3 desktop/scripts/make-fixtures.py /tmp/fixtures
#   xvfb-run -a desktop/scripts/fixture-matrix.sh desktop/src-tauri/target/debug/flowrad-viewer /tmp/fixtures
set -u
BIN="$1"; F="$2"; ok=0; fail=0
for p in "$F"/ts/* "$F/multiframe" "$F/cd-media" "$F/cd-media/DICOMDIR" "$F/archives/study.zip" "$F/real" "$F/pet-phantom" "$F/mr-brain" "$F/ct-phantom"; do
  # `real/` only exists when the pydicom samples were downloaded (CI uses --no-download).
  if [ ! -e "$p" ]; then echo "SKIP ${p#$F/}  (not generated)"; continue; fi
  out=$(FLOWRAD_BENCH=1 FLOWRAD_BENCH_EXIT=1 timeout 60 "$BIN" "$p" 2>/dev/null | grep '^FLOWRAD_BENCH ' || true)
  if [ -z "$out" ]; then fail=$((fail+1)); echo "FAIL ${p#$F/}  (no report)"
  elif echo "$out" | grep -q '"nonBlank":true\|"expectVisible":false'; then ok=$((ok+1)); echo "OK   ${p#$F/}"
  else fail=$((fail+1)); echo "FAIL ${p#$F/}  (blank viewport: $(echo "$out" | grep -o '"viewport":{[^}]*}'))"; fi
done
echo "ok=$ok fail=$fail"
[ "$fail" -eq 0 ]
