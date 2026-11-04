#!/usr/bin/env python3
"""Temporary (diagnostics): print FLOWRAD_DIAG runs as one timeline on the process clock."""
import json
import sys


def runs(path):
    diag = None
    splash = None
    for line in open(path, encoding="utf-8", errors="replace"):
        if line.startswith("FLOWRAD_DIAG "):
            diag = json.loads(line[len("FLOWRAD_DIAG "):])
        elif line.startswith("FLOWRAD_SPLASH "):
            splash = json.loads(line[len("FLOWRAD_SPLASH "):])
        elif line.startswith("FLOWRAD_BENCH "):
            yield diag, json.loads(line[len("FLOWRAD_BENCH "):]), splash
            diag = None
            splash = None


def main():
    for path in sys.argv[1:]:
        print(f"======== {path}")
        for n, (diag, report, splash) in enumerate(runs(path), 1):
            page = report.get("diag") or {}
            offset = None
            if report.get("coldStart") and "diagProcessAtNow" in report:
                offset = report["diagProcessAtNow"] - report["diagNow"]
            elif report.get("openAtProcessMs") is not None:
                opened = [t for t, l in page.get("marks", []) if l == "open start"]
                if opened:
                    offset = report["openAtProcessMs"] - opened[0]
            keys = ["openAtProcessMs", "firstSeriesHungMs", "viewChunksMs", "firstViewportSentMs", "firstImageMs", "firstPaintMs", "navStartMs", "windowBuiltMs", "webviewNavStartMs"]
            print(f"---- run {n}: " + ", ".join(f"{k}={report.get(k)}" for k in keys if report.get(k) is not None))
            print(f"     page->process offset {offset}; splash {splash}")
            if page.get("nav"):
                print(f"     page nav {page['nav']} paints {page.get('paints')}")
            rows = []
            if diag:
                for t, label, main in diag.get("events", []):
                    rows.append((t, "rust" + ("/main" if main else ""), label))
                for t, late in diag.get("mainLate", []):
                    rows.append((t, "MAIN LATE", f"{late} ms (until {round(t + late, 1)})"))
                for t, s in diag.get("states", []):
                    rows.append((t, "state", s))
                for s in diag.get("samples", []):
                    print(f"     sample: {s}")
            off = offset or 0
            for t, label in page.get("marks", []):
                rows.append((t + off, "page", label))
            for t, late, vis in page.get("timerLate", []):
                rows.append((t + off, "PAGE TIMER LATE", f"{late} ms (until {round(t + off + late, 1)}) {vis}"))
            for t, late in page.get("workerLate", []):
                rows.append((t + off, "WORKER LATE", f"{late} ms (until {round(t + off + late, 1)})"))
            for t, what in page.get("visibility", []):
                rows.append((t + off, "page vis", what))
            for t, cmd, ms in page.get("invokes", []):
                rows.append((t + off, "page invoke", f"{cmd} {ms} ms (until {round(t + off + ms, 1)})"))
            for name, start, rs, re_, dur in page.get("resources", []):
                if dur and dur > 20:
                    rows.append((start + off, "page fetch", f"{name} start->responseStart {round((rs or 0) - start, 1)} end {round(re_ - start, 1)} ms"))
            for t, kind, label in sorted(rows, key=lambda r: r[0]):
                if kind.startswith("rust") and label.startswith("window event: Moved"):
                    continue
                print(f"  {t:9.1f}  {kind:16s} {label}")


main()
