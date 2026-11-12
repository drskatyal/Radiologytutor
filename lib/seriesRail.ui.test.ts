import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CaseSeries } from "./viewerSource.ts";
import type { RailStats } from "./seriesRail.ts";

/**
 * The rail must not ask for covers before the viewport's first image, and
 * must show the real count plus a middle-slice thumbnail once that image is up.
 * `mainImageReady` is the viewer's onReady, which runs after setStack.
 */

const study = "1.2.826.0.1.3680043.8.498.upenn";
const t1 = "1.2.840.series.t1";
const flair = "1.2.840.series.flair";

function entry(uid: string, description: string): CaseSeries {
  return {
    seriesInstanceUID: uid,
    studyInstanceUID: study,
    modality: "MR",
    description,
    seriesNumber: uid === t1 ? 1 : 3,
    instanceCount: 0,
    wadoRsRoot: "/api/dicomweb",
  };
}

const headers: CaseSeries[] = [entry(t1, "T1"), entry(flair, "FLAIR")];

const listed = [
  {
    seriesInstanceUID: t1,
    instances: [1, 2, 3, 4, 5].map((n) => ({
      sopInstanceUID: `1.2.sop.${n}`,
      instanceNumber: n,
    })),
  },
];

type Harness = {
  render: (ready: boolean) => void;
  calls: string[];
  cleanup: () => void;
};

let harness: Harness;

before(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!DOCTYPE html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const { window } = dom;
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
  g.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(Date.now()), 16);
  g.cancelAnimationFrame = (id: number) => window.clearTimeout(id);

  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SeriesNavigator } = await import("../components/viewer/SeriesNavigator.tsx");
  const { useLazySeriesRail } = await import("../components/viewer/useLazySeriesRail.ts");
  const { act } = React;

  let resolveFlair: (stats: RailStats) => void = () => {};
  const flairStats = new Promise<RailStats>((resolve) => {
    resolveFlair = resolve;
  });
  const calls: string[] = [];
  const loadStats = (item: CaseSeries) => {
    calls.push(item.seriesInstanceUID);
    return flairStats;
  };

  const container = window.document.getElementById("root");
  if (!container) throw new Error("missing root");
  const root = createRoot(container);

  function Rail({ ready }: { ready: boolean }) {
    const rail = useLazySeriesRail(headers, ready, listed, loadStats);
    return React.createElement(SeriesNavigator, {
      series: rail,
      activeIndex: 0,
      onSelect: () => {},
    });
  }

  harness = {
    calls,
    cleanup() {
      act(() => root.unmount());
      window.close();
    },
    render(ready: boolean) {
      act(() => {
        root.render(React.createElement(Rail, { ready }));
      });
    },
  };

  // Exposed for the settle step. The promise is single-shot.
  Object.assign(harness, { resolveFlair });
});

after(() => {
  harness?.cleanup();
});

function view(): { document: Document } {
  return globalThis as unknown as { document: Document };
}

function buttons(): Element[] {
  return [...view().document.querySelectorAll("button")];
}

test("rail counts and thumbnails wait for the main image, then render the middle slice", async () => {
  const React = await import("react");
  const { act } = React;
  const resolveFlair = (harness as Harness & { resolveFlair: (stats: RailStats) => void }).resolveFlair;

  harness.render(false);
  assert.equal(harness.calls.length, 0, "no instance lookup before the main image");
  assert.equal(view().document.querySelector("img"), null);
  assert.equal(view().document.body.textContent?.includes("0 images"), false);
  const before = buttons();
  assert.equal(before.length, 2);
  assert.match(before[0]?.getAttribute("aria-label") ?? "", /T1, MR, 5 images/);
  assert.match(before[1]?.getAttribute("aria-label") ?? "", /FLAIR, MR, image count loading/);

  harness.render(true);
  assert.deepEqual(harness.calls, [flair], "only the series missing from the manifest is fetched");
  const t1Img = view().document.querySelector("img");
  assert.ok(t1Img);
  assert.match(
    t1Img.getAttribute("src") ?? "",
    /\/studies\/.*\/series\/1\.2\.840\.series\.t1\/instances\/1\.2\.sop\.3\/rendered\?viewport=96,96$/
  );
  assert.equal(
    view().document.querySelectorAll("img").length,
    1,
    "FLAIR has no cover until its lookup returns"
  );

  await act(async () => {
    resolveFlair({ instanceCount: 127, thumbnailInstanceUID: "1.2.sop.mid" });
    await Promise.resolve();
  });

  const labels = buttons().map((button) => button.getAttribute("aria-label"));
  assert.match(labels[0] ?? "", /5 images/);
  assert.match(labels[1] ?? "", /127 images/);
  const srcs = [...view().document.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? "");
  assert.equal(srcs.length, 2);
  assert.ok(srcs.some((src) => src.includes("/instances/1.2.sop.3/rendered")));
  assert.ok(srcs.some((src) => src.includes("/instances/1.2.sop.mid/rendered")));
  assert.equal(view().document.body.textContent?.includes("0 images"), false);
});
