#!/usr/bin/env bash
# Regenerate every Owl Scan icon from brand/owlscan.svg.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p brand/build/out
PW_CHROMIUM="${PW_CHROMIUM:-$( [ -x /opt/pw-browsers/chromium ] && echo /opt/pw-browsers/chromium )}" node brand/build/build.mjs
python3 brand/build/pack.py
# Tauri's own generator on the 1024 render: icon.ico (16–256), icon.icns,
# Windows Square*/StoreLogo and the bundle PNGs.
(cd desktop && npx tauri icon app-icon.png -o src-tauri/icons)
# Mobile targets are not shipped.
rm -rf desktop/src-tauri/icons/android desktop/src-tauri/icons/ios
