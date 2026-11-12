import { matchesView } from "./match";
import type { RenderAck, RenderedView, ViewCommand } from "./types";

export class ViewRequestError extends Error {
  constructor(readonly code: "missing_identity" | "timeout" | "cancelled" | "unavailable", message: string) { super(message); this.name = "ViewRequestError"; }
}
/** Only publish() from the actual renderer can release a command; drive/settle cannot. */
export class RenderCoordinator {
  private listeners = new Set<(view: RenderedView) => void>();
  private latest: RenderedView | null = null;
  private cancelPending: (() => void) | null = null;
  subscribe(fn: (view: RenderedView) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  get current(): RenderedView | null { return this.latest; }
  publish(view: RenderedView): void {
    if (this.latest && view.snapshot.renderSeq <= this.latest.snapshot.renderSeq) return;
    this.latest = view;
    for (const listener of this.listeners) listener(view);
  }
  cancel(): void { this.cancelPending?.(); }
  request(command: ViewCommand, drive: (signal: AbortSignal) => Promise<void>): Promise<RenderAck> {
    this.cancel();
    const after = this.latest?.snapshot.renderSeq ?? -1;
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let done = false;
      const finish = (error?: unknown, view?: RenderedView) => {
        if (done) return;
        done = true; clearTimeout(timer); off(); this.cancelPending = null;
        if (error) { controller.abort(); reject(error); } else resolve({ ...view!, commandId: command.commandId, generation: command.generation });
      };
      const off = this.subscribe(view => {
        if (view.snapshot.renderSeq > after && matchesView(view.snapshot, command.snapshot)) finish(undefined, view);
      });
      const timer = setTimeout(() => finish(new ViewRequestError("timeout", "The requested image was not confirmed by the renderer")), command.timeoutMs ?? 5000);
      this.cancelPending = () => finish(new ViewRequestError("cancelled", "View request cancelled"));
      Promise.resolve().then(() => { if (!done) return drive(controller.signal); }).catch(error => finish(error));
    });
  }
}
