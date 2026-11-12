// Viewer activity that is not DOM input: a frame rendered, a series loading,
// a bench or voice command driving the viewport. The idle trim in App.tsx
// listens here as well as to pointer / wheel / key events, so it never trims
// (cache eviction + WebView2's Low memory target, which forces a full GC on
// the renderer's main thread) while images are being shown. Before this, any
// interaction not made with the mouse or keyboard was "idle" after 10 s: the
// HP bench's scripted scrolling hit a 51-109 ms freeze every ~15 s.

type Listener = () => void;
const listeners = new Set<Listener>();
let last = 0;

/** Something on screen changed. Cheap: at most one notification per 250 ms. */
export function noteActivity(): void {
  const now = performance.now();
  if (now - last < 250) return;
  last = now;
  for (const l of listeners) l();
}

export function onActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
