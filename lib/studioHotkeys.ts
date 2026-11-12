/** Studio-only shortcuts. Never steal typing, IME, repeats or modified undo. */
export function isStudioTypingTarget(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown; isContentEditable?: boolean } | null;
  return !!el?.isContentEditable || !!el?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]');
}
export function studioHotkey(e: Pick<KeyboardEvent, "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "repeat" | "isComposing" | "target">): "record" | "undo-marker" | null {
  if (e.repeat || e.isComposing || isStudioTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.shiftKey || !e.altKey) return null;
  if (e.code === "KeyX" || e.key.toLowerCase() === "x") return "record";
  if (e.code === "KeyZ" || e.key.toLowerCase() === "z") return "undo-marker";
  return null;
}
