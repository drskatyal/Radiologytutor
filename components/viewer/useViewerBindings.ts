"use client";

// The web viewer's mouse & keyboard bindings: loaded once per page from
// localStorage["flowrad.bindings"] (signed out, and the offline copy) and
// published as the live bindings every viewport, tooltip and help sheet reads.
// The account copy (signed in; newest copy wins) is fetched only where a
// request is allowed: the viewer page shell on mount (before any study is
// opened — the free viewer's privacy gate allows no request after a drop),
// and when the reader opens Settings › Mouse & Keyboard. `save` writes both.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  getLiveBindings,
  loadStoredBindings,
  newerBindings,
  parseBindings,
  saveStoredBindings,
  setLiveBindings,
  subscribeLiveBindings,
  toBindingsFile,
  type BindingOverrides,
  type ParsedBindings,
} from "@flowrad/viewer-core/bindings";
import { WEB_COMMANDS } from "@/lib/viewerHotkeys";

let bootedLocal = false;
let accountTried = false;
let signedIn = false;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The local copy, once per page (no network). */
export function bootViewerBindings(): void {
  if (bootedLocal || typeof window === "undefined") return;
  bootedLocal = true;
  const local = loadStoredBindings(storage(), WEB_COMMANDS);
  if (local) setLiveBindings(local.overrides);
}

/** The account copy (signed in), once per page; the newer copy wins. */
export async function syncViewerBindingsWithAccount(): Promise<void> {
  bootViewerBindings();
  if (accountTried || typeof window === "undefined") return;
  accountTried = true;
  const local = loadStoredBindings(storage(), WEB_COMMANDS);
  try {
    const res = await fetch("/api/me/prefs", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return; // offline or failing: the local copy stands
    const data = (await res.json()) as { signedIn?: boolean; bindings?: unknown };
    if (!data.signedIn) return; // signed out: the local copy stands
    signedIn = true;
    let account: ParsedBindings | null = null;
    if (data.bindings) {
      try {
        account = parseBindings(data.bindings, WEB_COMMANDS);
      } catch {
        account = null;
      }
    }
    const winner = newerBindings(local, account);
    if (winner && winner === account) {
      setLiveBindings(winner.overrides);
      saveStoredBindings(storage(), winner.overrides, "web", undefined, winner.updatedAt);
    } else if (local) {
      void pushToAccount(local.overrides, local.updatedAt);
    }
  } catch {
    /* offline */
  }
}

async function pushToAccount(overrides: BindingOverrides, updatedAt?: string): Promise<void> {
  if (!signedIn) return;
  try {
    await fetch("/api/me/prefs", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bindings: toBindingsFile(overrides, "web", updatedAt) }),
    });
  } catch {
    /* saved locally; the next load pushes it */
  }
}

/** Save new bindings: live now, localStorage, and the account when signed in. */
export function saveViewerBindings(next: Record<string, string[]>): { local: boolean; account: boolean } {
  const updatedAt = new Date().toISOString();
  setLiveBindings(next);
  const local = saveStoredBindings(storage(), next, "web", undefined, updatedAt);
  void pushToAccount(next, updatedAt);
  return { local, account: signedIn };
}

export function viewerBindingsSyncedToAccount(): boolean {
  return signedIn;
}

/**
 * Boot (once per page) and subscribe to the live bindings. `account: true`
 * also fetches the signed-in copy — only from page shells, before a study opens.
 */
export function useViewerBindings(opts: { account?: boolean } = {}): { overrides: BindingOverrides; save: typeof saveViewerBindings } {
  const account = !!opts.account;
  useEffect(() => {
    if (account) void syncViewerBindingsWithAccount();
    else bootViewerBindings();
  }, [account]);
  const overrides = useSyncExternalStore(subscribeLiveBindings, getLiveBindings, getLiveBindings);
  const save = useCallback(saveViewerBindings, []);
  return { overrides, save };
}
