#!/usr/bin/env python3
"""Temporary (diagnostics): summarise macOS `sample` outputs (main thread tree + top of stack)."""
import re
import sys

THREAD = re.compile(r"^    (\d+) (Thread_\d+.*)$")
NODE = re.compile(r"^([\s+!:|]*?)(\d+) (.*)$")


def summarise(path):
    print(f"===== {path}")
    try:
        lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
    except OSError as e:
        print(f"  unreadable: {e}")
        return
    for l in lines[:14]:
        if l.strip():
            print(f"  | {l[:160]}")
    try:
        start = next(i for i, l in enumerate(lines) if l.startswith("Call graph:"))
    except StopIteration:
        print("  (no call graph)")
        return
    threads = []
    cur = None
    for l in lines[start + 1:]:
        if not l.strip():
            if threads:
                break
            continue
        m = THREAD.match(l)
        if m:
            cur = [int(m.group(1)), m.group(2), []]
            threads.append(cur)
        elif cur is not None:
            cur[2].append(l)
    if not threads:
        print("  (no threads parsed) raw:")
        for l in lines[start: start + 40]:
            print(f"  ~ {l[:200]}")
    for count, name, body in threads:
        print(f"  thread {count:6d} {name[:140]}")
    for count, name, body in threads:
        if "main-thread" not in name and threads.index([count, name, body]) != 0:
            continue
        print(f"  --- main thread tree ({count} samples), nodes >= 3%:")
        for l in body:
            m = NODE.match(l)
            if not m:
                continue
            depth = len(m.group(1)) // 2
            n = int(m.group(2))
            if n * 100 < count * 3 or depth > 60:
                continue
            frame = re.sub(r"\s*\[0x[0-9a-f]+(,0x[0-9a-f]+)*\]", "", m.group(3))
            frame = re.sub(r"\s+", " ", frame)
            print(f"  {'.' * min(depth, 40)}{n} {frame[:150]}")
        break
    try:
        top = next(i for i, l in enumerate(lines) if l.startswith("Sort by top of stack"))
        print("  --- top of stack:")
        for l in lines[top + 1: top + 40]:
            if not l.strip():
                continue
            print(f"  {re.sub(r'\s+', ' ', l)[:170]}")
    except StopIteration:
        pass


for p in sys.argv[1:]:
    summarise(p)
