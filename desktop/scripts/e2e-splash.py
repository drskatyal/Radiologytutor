#!/usr/bin/env python3
"""Cold start, macOS: the native splash (src-tauri/src/splash.rs, mac_splash.rs)
is shown first and then taken off again.

Screen grabs on the macOS runners need Screen Recording permission (without it
the window is missing from the capture), so the checks read the app's own
reports, with FLOWRAD_BENCH=1:

  1. the splash was on screen first: the cold-start report has a native first
     paint (`nativeFirstPaintMs`, source "splash"), before the page's first
     paint (`firstPaintMs`);
  2. it went the normal way: the `FLOWRAD_SPLASH` line says the page's
     `splash_done` took it off (not the 1 s after-load or 15 s fallbacks),
     after the page had painted its own copy, and no splash view is left in
     the window over the webview (`staleViews` 0);
  3. `FLOWRAD_NATIVE_SPLASH=0` turns it off: no native first paint, no
     `FLOWRAD_SPLASH` line.

Usage: python desktop/scripts/e2e-splash.py <app>
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time


def fail(msg: str) -> None:
    print(f"FAIL  {msg}")
    sys.exit(1)


def launch(exe: str, splash: bool, wait_splash: float) -> tuple[dict | None, dict | None, list[str]]:
    """The cold-start report and the splash line (None: not seen in time)."""
    env = {**os.environ, "FLOWRAD_BENCH": "1"}
    for k in ("FLOWRAD_BENCH_EXIT", "FLOWRAD_BENCH_VIEW", "FLOWRAD_NATIVE_SPLASH"):
        env.pop(k, None)
    if not splash:
        env["FLOWRAD_NATIVE_SPLASH"] = "0"
    proc = subprocess.Popen([exe], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    box: dict = {}
    tail: list[str] = []

    def read() -> None:
        assert proc.stdout
        for line in proc.stdout:
            tail.append(line.rstrip())
            del tail[:-40]
            for prefix, key in (("FLOWRAD_BENCH ", "report"), ("FLOWRAD_SPLASH ", "splash")):
                if line.startswith(prefix) and key not in box:
                    r = json.loads(line[len(prefix):])
                    if key == "splash" or r.get("coldStart"):
                        box[key] = r

    threading.Thread(target=read, daemon=True).start()
    try:
        deadline = time.time() + 90
        while "report" not in box and time.time() < deadline and proc.poll() is None:
            time.sleep(0.1)
        # The splash goes a few frames after the page's first paint (or, at
        # the latest, 15 s after launch).
        deadline = time.time() + wait_splash
        while "splash" not in box and time.time() < deadline and proc.poll() is None:
            time.sleep(0.1)
    finally:
        proc.kill()
        proc.wait()
    return box.get("report"), box.get("splash"), tail


def main() -> None:
    if len(sys.argv) < 2:
        fail("usage: e2e-splash.py <app>")
    exe = sys.argv[1]
    if sys.platform != "darwin":
        print("SKIP  the native splash dismissal report is macOS only")
        return

    report, splash, tail = launch(exe, splash=True, wait_splash=20)
    if report is None:
        fail("no cold-start report\n--- app output (last 40 lines) ---\n" + "\n".join(tail))
    native, page = report.get("nativeFirstPaintMs"), report.get("firstPaintMs")
    print(f"      native first paint {native} ms ({report.get('nativeFirstPaintSource')}), page first paint {page} ms, webview built {report.get('webviewBuiltMs')} ms")
    if not isinstance(native, (int, float)) or report.get("nativeFirstPaintSource") != "splash":
        fail("splash on: no native first paint in the cold-start report\n" + json.dumps(report, indent=2))
    if not isinstance(page, (int, float)) or not native < page:
        fail(f"splash on: the native splash ({native} ms) was not on screen before the page's first paint ({page} ms)")
    print(f"PASS  the native splash was on screen first: {native:.0f} ms, {page - native:.0f} ms before the page's first paint")

    if splash is None:
        fail("splash on: the splash was never taken off (no FLOWRAD_SPLASH line in 20 s)\n--- app output ---\n" + "\n".join(tail))
    print(f"      {json.dumps(splash)}")
    by, gone = splash.get("dismissedBy"), splash.get("dismissedMs")
    if by != "page":
        fail(f"splash on: taken off by the {by!r} fallback, not by the page's splash_done")
    if not isinstance(gone, (int, float)) or not gone > page:
        fail(f"splash on: taken off at {gone} ms, before the page's first paint ({page} ms): a gap with neither on screen")
    if splash.get("staleViews") != 0:
        fail(f"splash on: {splash.get('staleViews')} splash view(s) left in the window over the webview")
    print(f"PASS  the page took the splash off at {gone:.0f} ms ({gone - page:.0f} ms after its own first paint); nothing left over the webview")

    report, splash, tail = launch(exe, splash=False, wait_splash=3)
    if report is None:
        fail("splash off: no cold-start report\n--- app output (last 40 lines) ---\n" + "\n".join(tail))
    if report.get("nativeFirstPaintMs") is not None or splash is not None:
        fail(f"FLOWRAD_NATIVE_SPLASH=0: the splash still came on (native first paint {report.get('nativeFirstPaintMs')}, splash line {splash})")
    print(f"PASS  FLOWRAD_NATIVE_SPLASH=0: no native splash (page first paint {report.get('firstPaintMs')} ms)")


if __name__ == "__main__":
    main()
