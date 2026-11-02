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
       python desktop/scripts/e2e-native.py <app.exe> [<out-dir>] --study <ct-folder>   # P2.2: the real app
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


def run_report(exe: str, env: dict, args: list[str], timeout: float = 120) -> tuple[subprocess.Popen, dict | None, list[str]]:
    proc = subprocess.Popen([exe, *args], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    box: dict = {}
    tail: list[str] = []
    # Every report, in order (the tools mode reads the later OS-input ones).
    REPORTS.clear()

    def read() -> None:
        assert proc.stdout
        for line in proc.stdout:
            tail.append(line.rstrip())
            del tail[:-40]
            if line.startswith("FLOWRAD_BENCH "):
                r = json.loads(line[len("FLOWRAD_BENCH "):])
                REPORTS.append(r)
                if "r" not in box and r.get("view") != "native-tools-os":
                    box["r"] = r

    threading.Thread(target=read, daemon=True).start()
    deadline = time.time() + timeout
    while "r" not in box and time.time() < deadline and proc.poll() is None:
        time.sleep(0.2)
    return proc, box.get("r"), tail


REPORTS: list[dict] = []


def wait_report(pred, timeout: float = 20) -> dict | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for r in reversed(REPORTS):
            if pred(r):
                return r
        time.sleep(0.15)
    return None


def app_mode(exe: str, study: str, out_dir: Path) -> None:
    """P2.2: the real app, FLOWRAD_NATIVE=1, a CT on the command line: the
    first viewport is drawn natively under the page; grab it from the screen."""
    env = {**os.environ, "FLOWRAD_NATIVE": "1", "FLOWRAD_BENCH": "1"}
    env.pop("FLOWRAD_BENCH_EXIT", None)
    env.pop("FLOWRAD_BENCH_VIEW", None)
    proc, report, tail = run_report(exe, env, [study])
    try:
        if report is None:
            fail("app mode: no bench report\n" + "\n".join(tail))
        native, cell = report.get("native") or {}, report.get("nativeCell")
        print(json.dumps({k: report.get(k) for k in ("firstImagePaintedMs", "native", "nativeCell", "nativeStore", "longTasks")}, indent=2, default=str))
        if not native.get("ready"):
            fail(f"app mode: native renderer not ready: {native.get('error')}")
        if not cell:
            fail("app mode: no native viewport on screen (the series went to the JS path?)")
        time.sleep(0.8)
        from PIL import ImageGrab

        scale = native.get("scale") or 1
        ox, oy = native.get("clientOrigin") or [0, 0]
        x, y = int(ox + cell["x"] * scale), int(oy + cell["y"] * scale)
        w, h = int(cell["w"] * scale), int(cell["h"] * scale)
        img = ImageGrab.grab(bbox=(x, y, x + w, y + h), all_screens=True).convert("RGB")
        img.save(out_dir / "native-app-cell.png")
        px = img.load()
        # The middle third of the cell: real anatomy, grey, with contrast.
        samples = [px[int(w * (0.35 + 0.3 * i / 15)), int(h * (0.35 + 0.3 * j / 15))] for i in range(16) for j in range(16)]
        grey = sum(1 for c in samples if max(c) - min(c) <= 16) / len(samples)
        lum = [sum(c) / 3 for c in samples]
        spread = max(lum) - min(lum)
        ok = grey > 0.9 and spread > 40
        print(f"{'PASS' if ok else 'FAIL'}  app mode: the CT slice is drawn natively in the first viewport — grey {grey:.2f}, luminance spread {spread:.0f}")
        if not ok:
            sys.exit(1)
    finally:
        proc.kill()


def tools_mode(exe: str, study: str) -> None:
    """P2.3: the real tools drawn through pointer events on the native viewport."""
    env = {**os.environ, "FLOWRAD_NATIVE": "1", "FLOWRAD_BENCH": "1", "FLOWRAD_BENCH_VIEW": "native-tools"}
    env.pop("FLOWRAD_BENCH_EXIT", None)
    proc, report, tail = run_report(exe, env, [study])
    try:
        if report is None:
            fail("tools: no bench report\n" + "\n".join(tail))
        t = report.get("nativeTools") or {}
        print(json.dumps(t, indent=2, default=str))
        a = t.get("annotations") or {}
        checks = [
            ("Length drawn and measured", (a.get("Length") or {}).get("text", "").endswith("mm")),
            ("Ellipse ROI has Rust statistics", ((a.get("EllipticalROI") or {}).get("stats") or {}).get("pixels", 0) > 0),
            ("Rectangle ROI has Rust statistics", ((a.get("RectangleROI") or {}).get("stats") or {}).get("pixels", 0) > 0),
            ("Probe reads a value", (a.get("Probe") or {}).get("value") is not None),
            ("undo removes one, redo restores it", t.get("count") == 4 and t.get("afterUndo") == 3 and t.get("afterRedo") == 4),
            ("annotations are drawn over the native image", (t.get("drawnOnScreen") or 0) >= 4),
            # HP 0.8.0: Esc threw on every press (a Cornerstone call with a native element).
            ("Esc, tool keys, display / sync / reset keys: no error", not t.get("keyErrors"), ),
            # One step each way (the last step may be an add or a delete: Backspace removed the selected one).
            ("Ctrl+Z / Ctrl+Y undo / redo one native step", (lambda k: abs((k.get("afterUndo") or 0) - (k.get("before") or 0)) == 1 and k.get("afterRedo") == k.get("before"))(t.get("keyUndo") or {})),
            ("each tool shows its own cursor on the native viewport", (lambda c: all("url(" in c.get(k, "") for k in ("StackScroll", "WindowLevel", "Zoom")) and "grab" in c.get("Pan", "") and c.get("Length") == "crosshair")(t.get("cursors") or {})),
            ("the series thumbnail's right-click menu has items", (t.get("thumbMenuItems") or 0) >= 2),
        ]
        if t.get("keyErrors"):
            print("errors:", json.dumps(t.get("keyErrors"), indent=2))
        bad = 0
        for name, ok in checks:
            print(f"{'PASS' if ok else 'FAIL'}  tools: {name}")
            bad += 0 if ok else 1
        bad += os_input_checks()
        if bad:
            sys.exit(1)
    finally:
        proc.kill()


def os_input_checks() -> int:
    """Real mouse and keyboard (SendInput), not dispatched DOM events: a
    Length drag must draw on the native layer, and Ctrl+Z must take it away
    (HP 0.8.0: scripted drags showed nothing)."""
    if sys.platform != "win32":
        print("SKIP  tools (OS input): Windows only")
        return 0
    import ctypes

    user32 = ctypes.windll.user32
    user32.SetProcessDPIAware()
    ready = wait_report(lambda r: r.get("view") == "native-tools-os" and r.get("phase") == "ready", 20)
    if not ready or not ready.get("cellScreen"):
        print("FAIL  tools (OS input): no ready report with the layer's screen rect")
        return 1
    c = ready["cellScreen"]
    start = ready.get("count", 0)
    y = c["y"] + int(c["h"] * 0.72)
    x0, x1 = c["x"] + int(c["w"] * 0.25), c["x"] + int(c["w"] * 0.75)
    LEFTDOWN, LEFTUP = 0x0002, 0x0004
    user32.SetCursorPos(x0, y)
    time.sleep(0.2)
    user32.mouse_event(LEFTDOWN, 0, 0, 0, 0)
    for i in range(1, 21):
        user32.SetCursorPos(x0 + (x1 - x0) * i // 20, y)
        time.sleep(0.03)
    user32.mouse_event(LEFTUP, 0, 0, 0, 0)
    drawn = wait_report(lambda r: r.get("view") == "native-tools-os" and r.get("phase") == "count" and r.get("count", 0) > start, 10)
    from PIL import ImageGrab

    def coloured_on_line() -> int:
        img = ImageGrab.grab(bbox=(x0, y - 3, x1, y + 4), all_screens=True).convert("RGB")
        px = img.load()
        return sum(1 for i in range(img.width) for j in range(img.height) if max(px[i, j]) - min(px[i, j]) > 60)

    time.sleep(0.4)
    on_line = coloured_on_line()
    bad = 0
    ok = bool(drawn) and (drawn.get("lengths") or 0) >= 1 and (drawn.get("drawn") or 0) >= 1
    print(f"{'PASS' if ok else 'FAIL'}  tools (OS input): a real mouse drag with Length adds a measurement — {json.dumps(drawn)}")
    bad += 0 if ok else 1
    ok = on_line > 20
    print(f"{'PASS' if ok else 'FAIL'}  tools (OS input): the line is on screen over the native image ({on_line} coloured px)")
    bad += 0 if ok else 1
    # Ctrl+Z with the real keyboard.
    CTRL, Z, KEYUP = 0x11, 0x5A, 0x0002
    user32.keybd_event(CTRL, 0, 0, 0)
    user32.keybd_event(Z, 0, 0, 0)
    user32.keybd_event(Z, 0, KEYUP, 0)
    user32.keybd_event(CTRL, 0, KEYUP, 0)
    n = (drawn or {}).get("count", start + 1)
    undone = wait_report(lambda r: r.get("view") == "native-tools-os" and r.get("phase") == "count" and r.get("count", 99) == n - 1, 10)
    time.sleep(0.4)
    after = coloured_on_line()
    ok = bool(undone) and after < on_line // 2
    print(f"{'PASS' if ok else 'FAIL'}  tools (OS input): real Ctrl+Z removes it ({after} coloured px left) — {json.dumps(undone)}")
    bad += 0 if ok else 1
    errs = [e for r in REPORTS if r.get("view") == "native-tools-os" for e in (r.get("errors") or [])]
    ok = not errs
    print(f"{'PASS' if ok else 'FAIL'}  tools (OS input): no page errors {json.dumps(errs) if errs else ''}")
    return bad + (0 if ok else 1)


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    if "--study" in sys.argv:
        i = sys.argv.index("--study")
        study = sys.argv[i + 1]
        rest = [a for k, a in enumerate(sys.argv) if k not in (i, i + 1)]
        out = Path(rest[2] if len(rest) > 2 else ".")
        out.mkdir(parents=True, exist_ok=True)
        if "--tools" in rest:
            tools_mode(rest[1], study)
        else:
            app_mode(rest[1], study, out)
        return
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
