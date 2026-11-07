// The WebView2 / WebKit browser menu (Back, Refresh, Print, Inspect) has no
// place in a desktop app: right-clicking a reformat or slab viewport opened it
// (HP 0.8.1). One document-level listener cancels it everywhere except text
// fields, where Cut / Copy / Paste stay useful. Viewports open the app's own
// image menu from their React onContextMenu, which runs first.

interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

/** True where the browser's own menu is wanted: editable text. */
export function wantsBrowserMenu(target: TargetLike | null | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = ((target as { type?: string }).type ?? "").toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }
  if (target.isContentEditable) return true;
  return !!target.closest?.("[contenteditable=''], [contenteditable='true']");
}

/** Install once at startup; returns the uninstall function. */
export function installContextMenuGuard(doc: Document = document): () => void {
  const onMenu = (e: MouseEvent) => {
    if (!wantsBrowserMenu(e.target as TargetLike | null)) e.preventDefault();
  };
  doc.addEventListener("contextmenu", onMenu);
  return () => doc.removeEventListener("contextmenu", onMenu);
}
