import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { RecordedTrack } from "./types.ts";
import type { UseRecordReplay } from "../components/record/useRecordReplay.ts";

/**
 * Speak-once capture shares one recorder with the studio transport bar.
 * Stopping from either control must return the MicButton to the idle mic:
 * the label authors read, the accessible name, and the disc icon.
 */
type Studio = {
  container: HTMLElement;
  mount(): Promise<void>;
  click(el: HTMLElement): Promise<void>;
  speakOnceButton(): HTMLButtonElement;
  transportStop(): HTMLButtonElement | undefined;
};

let studio: Studio;
let releaseStudio: () => void = () => {};

before(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!DOCTYPE html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    })) as typeof window.matchMedia;
  }
  if (typeof window.ResizeObserver !== "function") {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof window.ResizeObserver;
  }

  const g = globalThis as typeof globalThis & Record<string, unknown>;
  const define = (name: string, value: unknown) => {
    Object.defineProperty(g, name, { configurable: true, writable: true, value });
  };
  define("window", window);
  define("document", window.document);
  define("navigator", window.navigator);
  define("HTMLElement", window.HTMLElement);
  define("HTMLButtonElement", window.HTMLButtonElement);
  define("SVGElement", window.SVGElement);
  define("Element", window.Element);
  define("Node", window.Node);
  define("MutationObserver", window.MutationObserver);
  define("ResizeObserver", window.ResizeObserver);
  define("IS_REACT_ACT_ENVIRONMENT", true);
  define("getComputedStyle", window.getComputedStyle.bind(window));
  g.requestAnimationFrame = (cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(Date.now()), 16);
  g.cancelAnimationFrame = (id: number) => window.clearTimeout(id);

  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = React;
  const { ContinuousCapture } = await import("../components/author/ContinuousCapture.tsx");
  const { ToastProvider } = await import("../components/ui/Toast.tsx");

  const container = window.document.getElementById("root");
  if (!container) throw new Error("missing root");
  const root = createRoot(container);
  let generation = 0;
  releaseStudio = () => {
    act(() => {
      root.unmount();
    });
    window.close();
  };

  const capturedTrack = (): RecordedTrack => ({
    durationMs: 1800,
    start: { sliceIndex: 4, ww: 400, wc: 40 },
    events: [
      { t: 200, type: "slice", index: 12 },
      { t: 900, type: "cursor", x: 0.42, y: 0.58 },
    ],
  });

  function StudioSurface() {
    const [phase, setPhase] = React.useState<UseRecordReplay["phase"]>("idle");
    const [micCapture, setMicCapture] = React.useState<UseRecordReplay["micCapture"]>("unknown");
    const [track, setTrack] = React.useState<RecordedTrack | null>(null);
    const [audio, setAudio] = React.useState<UseRecordReplay["audio"]>(null);
    const [frames, setFrames] = React.useState<UseRecordReplay["frames"]>([]);
    const phaseRef = React.useRef(phase);
    phaseRef.current = phase;

    const rr: UseRecordReplay = {
      phase,
      supported: false,
      micCapture,
      elapsedMs: 1800,
      track,
      audio,
      frames,
      progress: 0,
      onViewerEvent() {},
      onCursor() {},
      async startRecording() {
        if (phaseRef.current !== "idle") return false;
        setMicCapture("unavailable");
        setPhase("recording");
        return true;
      },
      async stopRecording() {
        if (phaseRef.current !== "recording") return null;
        const next = capturedTrack();
        setTrack(next);
        setAudio(null);
        setFrames([]);
        setMicCapture("unavailable");
        setPhase("idle");
        return { track: next, audio: null, frames: [] };
      },
      replay() {},
      stopReplay() {},
      reset() {
        setTrack(null);
        setAudio(null);
        setFrames([]);
        setMicCapture("unknown");
      },
    };

    return React.createElement(
      ToastProvider,
      null,
      phase === "recording"
        ? React.createElement(
            "button",
            {
              type: "button",
              onClick: () => {
                void rr.stopRecording();
              },
            },
            "Stop recording"
          )
        : React.createElement(
            "button",
            {
              type: "button",
              onClick: () => {
                void rr.startRecording();
              },
            },
            "Record walk-through"
          ),
      React.createElement(ContinuousCapture, {
        caseId: "case-speak-once",
        rr,
        controls: { current: null },
        onCaseUpdated() {},
      })
    );
  }

  studio = {
    container,
    async mount() {
      generation += 1;
      const key = String(generation);
      await act(async () => {
        root.render(React.createElement(StudioSurface, { key }));
      });
    },
    async click(el: HTMLElement) {
      const view = el.ownerDocument.defaultView;
      assert.ok(view);
      await act(async () => {
        el.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    },
    speakOnceButton() {
      const button = [...container.querySelectorAll("button")].find((el) => {
        const text = el.textContent ?? "";
        return (
          text.includes("Start recording") ||
          text.includes("Capturing the viewer") ||
          text.includes("Processing")
        );
      });
      assert.ok(button instanceof window.HTMLButtonElement, "speak-once mic control");
      return button;
    },
    transportStop() {
      return [...container.querySelectorAll("button")].find(
        (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim() === "Stop recording"
      ) as HTMLButtonElement | undefined;
    },
  };
});

after(() => {
  releaseStudio();
});

function assertSpeakOnceIdle(root: ParentNode) {
  const button = [...root.querySelectorAll("button")].find((el) =>
    (el.textContent ?? "").includes("Start recording")
  );
  assert.ok(button instanceof HTMLButtonElement, "idle speak-once control");
  assert.equal(button.getAttribute("aria-label"), "Start recording");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.querySelector(".lucide-square"), null);
  assert.ok(button.querySelector(".lucide-mic"), "idle control shows the mic disc");
  assert.equal(button.querySelector(".animate-mic-pulse"), null);
  assert.equal(button.querySelector(".bg-danger"), null);
  assert.equal(button.querySelector("[role='status']"), null);
  const stale = [...root.querySelectorAll("button")].filter((el) => {
    const name = el.getAttribute("aria-label") ?? "";
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    return name === "Stop recording" || text === "Stop recording";
  });
  assert.equal(stale.length, 0);
}

test("speak-once describes compiling from the recording", async () => {
  await studio.mount();
  const text = studio.container.textContent ?? "";
  assert.match(text, /viewport stills/i);
  assert.doesNotMatch(text, /Transcribing/);
});

test("stopping speak-once from the transport bar returns the idle mic", async () => {
  await studio.mount();
  await studio.click(studio.speakOnceButton());
  const recording = studio.speakOnceButton();
  assert.equal(recording.getAttribute("aria-label"), "Stop recording");
  assert.match(recording.textContent ?? "", /Capturing the viewer — no microphone/);
  assert.ok(recording.querySelector(".lucide-square"));
  assert.ok(recording.querySelector(".bg-danger"));

  const transport = studio.transportStop();
  assert.ok(transport, "studio transport Stop recording");
  await studio.click(transport);

  assertSpeakOnceIdle(studio.container);
  assert.match(studio.container.textContent ?? "", /No microphone on this take/);
});

test("stopping a walk-through from the speak-once control returns the idle mic", async () => {
  await studio.mount();
  const record = [...studio.container.querySelectorAll("button")].find((el) =>
    (el.textContent ?? "").includes("Record walk-through")
  );
  assert.ok(record instanceof HTMLButtonElement);
  await studio.click(record);
  const recording = studio.speakOnceButton();
  assert.equal(recording.getAttribute("aria-label"), "Stop recording");
  assert.ok(recording.querySelector(".lucide-square"));
  await studio.click(recording);

  assertSpeakOnceIdle(studio.container);
  assert.doesNotMatch(studio.container.textContent ?? "", /No microphone on this take/);
});

test("stopping speak-once on the mic returns the idle name and hides the stop icon", async () => {
  await studio.mount();
  await studio.click(studio.speakOnceButton());
  const recording = studio.speakOnceButton();
  assert.equal(recording.getAttribute("aria-label"), "Stop recording");
  await studio.click(recording);

  assertSpeakOnceIdle(studio.container);
  assert.match(studio.container.textContent ?? "", /No microphone on this take/);
});
