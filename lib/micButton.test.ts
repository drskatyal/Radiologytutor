import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ReactNode } from "react";
import type { MicState } from "../components/ui/MicButton.tsx";

/**
 * Renders MicButton into jsdom and activates it the way a keyboard or
 * browser-automation user does: by the visible label, not the icon alone.
 */
type Harness = {
  createElement: typeof import("react").createElement;
  cleanup: () => void;
  render: (props: {
    state: MicState;
    label?: ReactNode;
    onStart?: () => void;
    onStop?: () => void;
  }) => {
    button: HTMLButtonElement;
    calls: { start: number; stop: number };
  };
};

let harness: Harness;

before(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
    { url: "http://localhost/", pretendToBeVisual: true }
  );
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

  const g = globalThis as typeof globalThis & Record<string, unknown>;
  const define = (name: string, value: unknown) => {
    Object.defineProperty(g, name, { configurable: true, writable: true, value });
  };
  define("window", window);
  define("document", window.document);
  define("navigator", window.navigator);
  define("HTMLElement", window.HTMLElement);
  define("SVGElement", window.SVGElement);
  define("Element", window.Element);
  define("Node", window.Node);
  define("MutationObserver", window.MutationObserver);
  define("IS_REACT_ACT_ENVIRONMENT", true);
  define("getComputedStyle", window.getComputedStyle.bind(window));
  g.requestAnimationFrame = (cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(Date.now()), 16);
  g.cancelAnimationFrame = (id: number) => window.clearTimeout(id);

  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { MicButton } = await import("../components/ui/MicButton.tsx");
  const { act } = React;

  const container = window.document.getElementById("root");
  if (!container) throw new Error("missing root");
  const root = createRoot(container);

  harness = {
    createElement: React.createElement,
    cleanup() {
      act(() => root.unmount());
      window.close();
    },
    render(props) {
      const calls = { start: 0, stop: 0 };
      act(() => {
        root.render(
          React.createElement(MicButton, {
            state: props.state,
            label: props.label,
            onStart: () => {
              calls.start += 1;
              props.onStart?.();
            },
            onStop: () => {
              calls.stop += 1;
              props.onStop?.();
            },
          })
        );
      });
      const button = container.querySelector("button");
      assert.ok(button instanceof window.HTMLButtonElement, "expected one button");
      return { button, calls };
    },
  };
});

after(() => {
  harness?.cleanup();
});

function visibleLabel(button: HTMLButtonElement, text: string): HTMLElement {
  const label = [...button.querySelectorAll("span")].find((el) => el.textContent === text);
  assert.ok(
    label,
    `visible label ${JSON.stringify(text)} should be inside the button (accessible name: ${button.getAttribute("aria-label")})`
  );
  assert.equal(label.closest("button"), button);
  return label;
}

function clickLabel(button: HTMLButtonElement, text: string) {
  const label = visibleLabel(button, text);
  const view = button.ownerDocument.defaultView;
  assert.ok(view);
  label.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }));
}

test("idle MicButton is named and started by a custom label string", () => {
  for (const label of [
    "Start continuous capture",
    "Hold to speak",
    "Tap to talk",
    "Dictate finding",
  ]) {
    const { button, calls } = harness.render({ state: "idle", label, onStart() {}, onStop() {} });
    assert.equal(button.getAttribute("aria-label"), label);
    assert.equal(button.disabled, false);
    clickLabel(button, label);
    assert.equal(calls.start, 1, `clicking ${JSON.stringify(label)} should start`);
    assert.equal(calls.stop, 0);
  }
});

test("recording MicButton keeps the stop name and the capturing label", () => {
  for (const label of [
    "Capturing the viewer — no microphone",
    "Capturing the viewer…",
    "Capturing — keep scrolling & speaking…",
    "Release to send",
  ]) {
    const { button, calls } = harness.render({
      state: "recording",
      label,
      onStart() {},
      onStop() {},
    });
    assert.equal(button.getAttribute("aria-label"), "Stop recording");
    assert.equal(button.getAttribute("aria-pressed"), "true");
    clickLabel(button, label);
    assert.equal(calls.stop, 1, `clicking ${JSON.stringify(label)} should stop`);
    assert.equal(calls.start, 0);
  }
});

test("processing MicButton keeps the processing name and ignores the label click", () => {
  const { button, calls } = harness.render({
    state: "processing",
    label: "Structuring session…",
    onStart() {},
    onStop() {},
  });
  assert.equal(button.getAttribute("aria-label"), "Processing audio");
  assert.equal(button.disabled, true);
  clickLabel(button, "Structuring session…");
  assert.equal(calls.start, 0);
  assert.equal(calls.stop, 0);
});

test("MicButton without a label keeps the default names and visible copy", () => {
  const idle = harness.render({ state: "idle", onStart() {}, onStop() {} });
  assert.equal(idle.button.getAttribute("aria-label"), "Start recording");
  clickLabel(idle.button, "Hold to ask");
  assert.equal(idle.calls.start, 1);
  assert.equal(idle.calls.stop, 0);

  const recording = harness.render({ state: "recording", onStart() {}, onStop() {} });
  assert.equal(recording.button.getAttribute("aria-label"), "Stop recording");
  clickLabel(recording.button, "Listening…");
  assert.equal(recording.calls.stop, 1);
  assert.equal(recording.calls.start, 0);

  const processing = harness.render({ state: "processing", onStart() {}, onStop() {} });
  assert.equal(processing.button.getAttribute("aria-label"), "Processing audio");
  assert.equal(processing.button.disabled, true);
  clickLabel(processing.button, "Thinking…");
  assert.equal(processing.calls.start, 0);
  assert.equal(processing.calls.stop, 0);
});

test("a non-string label stays inside the control and keeps the default name", () => {
  const { button, calls } = harness.render({
    state: "idle",
    label: harness.createElement("span", { className: "text-success" }, "Sample ready"),
    onStart() {},
    onStop() {},
  });
  assert.equal(button.getAttribute("aria-label"), "Start recording");
  clickLabel(button, "Sample ready");
  assert.equal(calls.start, 1);
  assert.equal(calls.stop, 0);
});
