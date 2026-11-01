#!/usr/bin/env python3
"""Drop the OS file cache so a "cold" benchmark really reads from disk.

    python3 desktop/scripts/flush-file-cache.py            # prints what it did, exit 0 even if it could not
    python3 desktop/scripts/flush-file-cache.py --require  # exit 1 if the cache could not be flushed

Windows: purges the standby list (NtSetSystemInformation, SystemMemoryListInformation
= 80, MemoryPurgeStandbyList = 4) after enabling SeProfileSingleProcessPrivilege —
needs an elevated process (GitHub's Windows runners are). The modified list is
flushed to disk first (MemoryFlushModifiedList = 3).
Linux: sync + /proc/sys/vm/drop_caches = 3 (root, or passwordless sudo).
macOS: purge (needs sudo).

Without this, "cold" runs after the first read the study from RAM: the HP's cold
numbers were not reproducible in CI (0.6.1 report).
"""
from __future__ import annotations

import ctypes
import os
import subprocess
import sys


def flush_windows() -> str:
    from ctypes import wintypes

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll")

    class LUID(ctypes.Structure):
        _fields_ = [("LowPart", wintypes.DWORD), ("HighPart", wintypes.LONG)]

    class LUID_AND_ATTRIBUTES(ctypes.Structure):
        _fields_ = [("Luid", LUID), ("Attributes", wintypes.DWORD)]

    class TOKEN_PRIVILEGES(ctypes.Structure):
        _fields_ = [("PrivilegeCount", wintypes.DWORD), ("Privileges", LUID_AND_ATTRIBUTES * 1)]

    # 64-bit handles: declare the signatures, or ctypes truncates the
    # GetCurrentProcess() pseudo-handle (-1) and OpenProcessToken fails (6).
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.OpenProcessToken.restype = wintypes.BOOL
    advapi.LookupPrivilegeValueW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p]
    advapi.AdjustTokenPrivileges.argtypes = [wintypes.HANDLE, wintypes.BOOL, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p]
    ntdll.NtSetSystemInformation.argtypes = [ctypes.c_int, ctypes.c_void_p, wintypes.ULONG]
    ntdll.NtSetSystemInformation.restype = ctypes.c_long
    token = wintypes.HANDLE()
    TOKEN_ADJUST_PRIVILEGES, TOKEN_QUERY, SE_PRIVILEGE_ENABLED = 0x20, 0x8, 0x2
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, ctypes.byref(token)):
        raise OSError(f"OpenProcessToken failed ({ctypes.get_last_error()})")
    luid = LUID()
    if not advapi.LookupPrivilegeValueW(None, "SeProfileSingleProcessPrivilege", ctypes.byref(luid)):
        raise OSError(f"LookupPrivilegeValue failed ({ctypes.get_last_error()})")
    tp = TOKEN_PRIVILEGES(1, (LUID_AND_ATTRIBUTES * 1)(LUID_AND_ATTRIBUTES(luid, SE_PRIVILEGE_ENABLED)))
    ctypes.set_last_error(0)
    advapi.AdjustTokenPrivileges(token, False, ctypes.byref(tp), 0, None, None)
    if ctypes.get_last_error() != 0:
        raise OSError("SeProfileSingleProcessPrivilege not held (run elevated)")
    for command in (3, 4):  # flush modified list, then purge standby list
        value = ctypes.c_int(command)
        status = ntdll.NtSetSystemInformation(80, ctypes.byref(value), ctypes.sizeof(value))
        if status != 0:
            raise OSError(f"NtSetSystemInformation({command}) NTSTATUS 0x{status & 0xFFFFFFFF:08X}")
    return "windows standby list purged"


def flush_linux() -> str:
    os.sync()
    try:
        with open("/proc/sys/vm/drop_caches", "w") as f:
            f.write("3\n")
        return "linux page cache dropped"
    except PermissionError:
        subprocess.run(["sudo", "-n", "sh", "-c", "echo 3 > /proc/sys/vm/drop_caches"], check=True, capture_output=True)
        return "linux page cache dropped (sudo)"


def flush_macos() -> str:
    subprocess.run(["sudo", "-n", "purge"], check=True, capture_output=True)
    return "macos purge"


def flush() -> tuple[bool, str]:
    try:
        if sys.platform == "win32":
            return True, flush_windows()
        if sys.platform == "darwin":
            return True, flush_macos()
        return True, flush_linux()
    except Exception as e:  # noqa: BLE001 — report, the caller decides
        return False, f"file cache NOT flushed: {e}"


if __name__ == "__main__":
    ok, what = flush()
    print(what)
    sys.exit(0 if ok or "--require" not in sys.argv else 1)
