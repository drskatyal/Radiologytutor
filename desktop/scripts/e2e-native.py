#!/usr/bin/env python3
"""P2.0 e2e (docs/NATIVE_RENDERER.md): do the native wgpu surface and the
transparent WebView2 above it composite on screen?

Launches the app with FLOWRAD_NATIVE=1 and the native-spike view, waits for its
bench report (adapter, IPC round trips, the cell's physical screen rect), grabs
that rect FROM THE SCREEN (what a user sees, not a readback of either layer)
and checks three things:

  1. native pixels show through the page: inside the test image the pixels
     are grey and the ramp runs dark (left) to bright (right);
  2. the page draws ON TOP of them: the overlay's vertical crosshair line is
     there, in colour, over the native image;
  3. the native surface fills the cell: outside the (square) image the cell is
     black, not the page's background.

Writes the grab to <out-dir>/native-spike.png. Windows only for now (the
Linux CI job keeps the JS path, see the design note).

Usage: python desktop/scripts/e2e-native.py <app.exe> [<out-dir>]
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path


# Windows consoles default to cp1252: print the check names (arrows, dashes) as UTF-8.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def fail(msg: str) -> None:
    print(f"FAIL  {msg}")
    sys.exit(1)


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    exe = sys.argv[1]
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else ".")
    out_dir.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "FLOWRAD_NATIVE": "1", "FLOWRAD_BENCH": "1", "FLOWRAD_BENCH_VIEW": "native-spike"}
    env.pop("FLOWRAD_BENCH_EXIT", None)
    proc = subprocess.Popen([exe], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    report: dict | None = None
    tail: list[str] = []

    def read() -> None:
        nonlocal report
        assert proc.stdout
        for line in proc.stdout:
            tail.append(line.rstrip())
            del tail[:-40]
            if line.startswith("FLOWRAD_BENCH ") and report is None:
                r = json.loads(line[len("FLOWRAD_BENCH "):])
                # The app's start screen can report first (cold-start probe)
                # while the spike view is still being chosen: wait for the spike's.
                if r.get("view") == "native-spike":
                    report = r

    threading.Thread(target=read, daemon=True).start()
    deadline = time.time() + 90
    while report is None and time.time() < deadline and proc.poll() is None:
        time.sleep(0.2)
    try:
        if report is None:
            fail("no report from the native-spike view\n" + "\n".join(tail))
        native = report.get("native") or {}
        print(json.dumps({k: report.get(k) for k in ("native", "ipc", "cellScreen", "longTasks")}, indent=2))
        if not native.get("ready"):
            fail(f"native renderer not ready: {native.get('error')}")
        cell = report.get("cellScreen")
        if not cell:
            fail("no cell rect in the report")
        time.sleep(0.5)
        from PIL import ImageGrab

        x, y, w, h = cell["x"], cell["y"], cell["w"], cell["h"]
        img = ImageGrab.grab(bbox=(x, y, x + w, y + h), all_screens=True).convert("RGB")
        img.save(out_dir / "native-spike.png")
        px = img.load()
        side = min(w, h)
        cx, cy = w // 2, h // 2

        def at(fx: float, fy: float) -> tuple[int, int, int]:
            return px[int(cx + fx * side), int(cy + fy * side)]

        def grey(c: tuple[int, int, int]) -> bool:
            return max(c) - min(c) <= 16

        checks: list[tuple[str, bool, str]] = []
        # 1. Native ramp, sampled on a row away from the crosshair.
        left, right = at(-0.35, -0.3), at(0.35, -0.3)
        checks.append(("native pixels show through the transparent page (grey ramp, dark → bright)",
                       grey(left) and grey(right) and sum(right) - sum(left) > 150, f"left {left} right {right}"))
        # 2. Overlay on top: the vertical crosshair (3 CSS px, warning colour) at the centre column.
        line = [px[cx + dx, int(cy - 0.3 * side)] for dx in range(-3, 4)]
        coloured = [c for c in line if max(c) - min(c) > 60]
        checks.append(("the page's overlay draws on top of the native image", bool(coloured), f"centre column {line}"))
        # 3. Outside the square image (wide cell: left/right margins) the native clear is black.
        if w > h + 40:
            margin = px[int((w - side) / 4), cy // 2]
            checks.append(("the native surface fills the cell (black around the image)", max(margin) < 40, f"margin {margin}"))
        ipc = report.get("ipc") or {}
        checks.append(("W/L over IPC re-renders (60 calls answered)", (ipc.get("calls") or 0) >= 60, json.dumps(ipc)))
        failed = 0
        for name, ok, detail in checks:
            print(f"{'PASS' if ok else 'FAIL'}  {name}  — {detail}")
            failed += 0 if ok else 1
        if failed:
            sys.exit(1)
    finally:
        proc.kill()


if __name__ == "__main__":
    main()
