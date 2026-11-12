export type HoldRelease = 'release' | 'blur' | 'hidden' | 'escape' | 'cancel' | 'maximum';
export interface HoldRecorder<T> { start(): Promise<void>; stop(): Promise<T | null> }
export interface HoldOptions<T> {
  recorder: HoldRecorder<T>; submit(value: T): void | Promise<void>;
  interrupt(): void; state?(phase: 'idle' | 'starting' | 'recording', message?: string): void;
  now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
  minMs?: number; maxMs?: number;
}
/** A single held capture. Release during permission wait still stops a late stream. */
export class HoldToTalk<T> {
  private pending: Promise<void> | null = null;
  private held = false;
  private reason: HoldRelease = 'release';
  private started: number | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private releaseCapture: (() => void) | null = null;
  constructor(private options: HoldOptions<T>) {}
  press(repeat = false): void {
    if (repeat || this.held || this.pending) return;
    this.held = true; this.reason = 'release'; this.started = null; this.options.interrupt(); this.options.state?.('starting');
    const released = new Promise<void>(r => { this.releaseCapture = r; });
    const now = this.options.now ?? (() => performance.now());
    this.pending = (async () => {
      try {
        await this.options.recorder.start();
        if (this.held) { this.started = now(); this.options.state?.('recording'); this.timer = (this.options.setTimer ?? setTimeout)(() => this.release('maximum'), this.options.maxMs ?? 30000); }
        await released;
        const duration = this.started === null ? 0 : now() - this.started;
        const value = await this.options.recorder.stop();
        const submit = ['release', 'maximum'].includes(this.reason) && duration >= (this.options.minMs ?? 250) && value !== null;
        this.options.state?.('idle', !submit && this.reason === 'release' ? 'Hold the microphone for at least a quarter second, then release to send.' : undefined);
        if (submit) void Promise.resolve(this.options.submit(value!)).catch(() => this.options.state?.("idle", "Voice question could not be sent. Try again."));
      } catch { this.options.state?.('idle', 'Microphone unavailable. Allow microphone access and hold again.'); }
      finally { (this.options.clearTimer ?? clearTimeout)(this.timer); this.held = false; this.releaseCapture = null; this.pending = null; }
    })();
  }
  release(reason: HoldRelease = 'release'): void {
    if (!this.held) { if (reason === 'escape') this.options.interrupt(); return; }
    this.held = false; this.reason = reason; (this.options.clearTimer ?? clearTimeout)(this.timer); this.releaseCapture?.();
    if (!['release', 'maximum'].includes(reason)) this.options.interrupt();
  }
  async settled() { await this.pending; }
}
export function textInputTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  return !!node && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(node.tagName) || node.isContentEditable);
}
/** Releases are handled even if focus moved into a text input during the hold. */
export function bindHoldKeys(target: Window, doc: Document, hold: Pick<HoldToTalk<unknown>, 'press' | 'release'>, blocked = () => false) {
  const down = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { hold.release('escape'); return; }
    if (event.code !== 'Space' || event.ctrlKey || event.altKey || event.metaKey || textInputTarget(event.target) || blocked()) return;
    event.preventDefault(); hold.press(event.repeat);
  };
  const up = (event: KeyboardEvent) => { if (event.code === 'Space') hold.release(); };
  const blur = () => hold.release('blur'), visibility = () => { if (doc.hidden) hold.release('hidden'); };
  target.addEventListener('keydown', down); target.addEventListener('keyup', up); target.addEventListener('blur', blur); doc.addEventListener('visibilitychange', visibility);
  return () => { target.removeEventListener('keydown', down); target.removeEventListener('keyup', up); target.removeEventListener('blur', blur); doc.removeEventListener('visibilitychange', visibility); hold.release('cancel'); };
}
