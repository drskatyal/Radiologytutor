#!/usr/bin/env python3
"""Temporary (diagnostics): the main thread of each spindump, frames with >= N samples."""
import re
import sys

MIN = 8


def show(path):
    print(f"===== {path}")
    try:
        lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
    except OSError as e:
        print(f"  unreadable: {e}")
        return
    for l in lines[:40]:
        if re.match(r"^(Date/Time|End time|Duration|Steps|Sampling Interval|Process|PID|Time Since Fork|Num samples|Footprint|CPU Time|Note)", l):
            print(f"  | {l[:180]}")
    start = None
    for i, l in enumerate(lines):
        if re.match(r"^\s+Thread 0x[0-9a-f]+", l) and ("main-thread" in l or "Main" in l):
            start = i
            break
    if start is None:
        print("  (no main thread found); first thread lines:")
        for l in [x for x in lines if "Thread 0x" in x][:10]:
            print(f"  ~ {l[:200]}")
        return
    print(f"  {lines[start].strip()[:200]}")
    shown = 0
    for l in lines[start + 1:]:
        if shown > 260:
            print("  ... (cut)")
            break
        if re.match(r"^\s+Thread 0x[0-9a-f]+", l) or (l.strip() == "" and False):
            break
        if l.strip().startswith("Binary Images"):
            break
        m = re.match(r"^(\s*)\*?(\d+)\s+(.*)$", l)
        if not m:
            continue
        n = int(m.group(2))
        if n < MIN:
            continue
        depth = len(m.group(1))
        frame = re.sub(r"\s*\[0x[0-9a-f]+\]", "", m.group(3))
        print(f"  {'.' * min(depth, 60)}{n} {frame[:170]}")
        shown += 1


for p in sys.argv[1:]:
    show(p)
