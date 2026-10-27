/**
 * Registrar harness — tool surface the AI teammate may call to drive the
 * DICOM “computer”. Single source of truth; Gemini (and future models) import
 * this registry rather than declaring tools ad hoc.
 *
 * See docs/HARNESS.md (Grok Bot parallel: tools on a persistent computer).
 */

import { parseSetSeriesArgs } from "../setSeries";

/** Minimal tool schema (Gemini / OpenAPI-compatible). */
export type HarnessToolDeclaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** Viewer actions the student client can execute. */
export type HarnessViewerAction =
  | { type: "show_finding"; findingId: string }
  | { type: "next_in_tour" }
  | { type: "prev_in_tour" }
  | { type: "set_window"; windowWidth: number; windowCenter: number }
  | {
      type: "point_to";
      findingId?: string;
      x_pct?: number;
      y_pct?: number;
    }
  | {
      type: "scroll_to";
      sliceIndex: number;
      seriesInstanceUID?: string;
      findingId?: string;
    }
  | {
      type: "set_series";
      /** Authored SeriesInstanceUID. Never a model-invented value. */
      seriesInstanceUID: string;
      sliceIndex?: number;
      /** Window width. Present only together with `wc`. */
      ww?: number;
      /** Window center. Present only together with `ww`. */
      wc?: number;
    }
  | { type: "zoom_to"; zoom: number; panX?: number; panY?: number }
  | { type: "set_zoom"; zoom: number; panX?: number; panY?: number }
  | { type: "set_invert"; value: boolean }
  | {
      type: "draw_annotation";
      findingId?: string;
      tool?: string;
      x_pct?: number;
      y_pct?: number;
      x2_pct?: number;
      y2_pct?: number;
    }
  | { type: "play_guide"; findingId: string }
  | { type: "none" };

/** Appended to every viewer tool so a tool call cannot replace the spoken answer. */
export const SPOKEN_ANSWER_TOOL_CLAUSE =
  "Always include a spoken answer of 1–3 sentences in the same turn. Never call this tool with an empty message.";

/** Gemini / OpenAPI-style function declarations for the tutor. */
const HARNESS_VIEWER_TOOL_BASE: HarnessToolDeclaration[] = [
  {
    name: "show_finding",
    description:
      "Drive the viewer to a specific finding (animating camera/window/slice), reveal its marker with a laser pointer approach, and narrate it. Use the finding's id.",
    parameters: {
      type: "object",
      properties: { findingId: { type: "string", description: "Finding id, e.g. f1" } },
      required: ["findingId"],
    },
  },
  {
    name: "next_in_tour",
    description: "Advance to the next finding in tour order and narrate it.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "prev_in_tour",
    description: "Go back to the previous finding in tour order.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "set_series",
    description:
      "Switch the active DICOM series (T1, T2, FLAIR, DWI, post-contrast, prior). seriesInstanceUID must be copied from the case series list or from a finding's series=, drive.series, or compare.series. Never invent a UID. Optional sliceIndex is the 0-based index on that series. Optional ww and wc are the authored window width and center. Omit sliceIndex to keep the current slice. Omit ww and wc to keep the current window.",
    parameters: {
      type: "object",
      properties: {
        seriesInstanceUID: {
          type: "string",
          description: "SeriesInstanceUID copied from the case series list or finding.drive / finding.compare",
        },
        sliceIndex: { type: "number", description: "0-based stack index on that series" },
        ww: { type: "number", description: "Authored window width" },
        wc: { type: "number", description: "Authored window center" },
      },
      required: ["seriesInstanceUID"],
    },
  },
  {
    name: "set_window",
    description:
      "Adjust the window width / center (VOI) on the current view to make a feature more conspicuous.",
    parameters: {
      type: "object",
      properties: {
        windowWidth: { type: "number" },
        windowCenter: { type: "number" },
      },
      required: ["windowWidth", "windowCenter"],
    },
  },
  {
    name: "point_to",
    description:
      "Animate a laser pointer to a place on the current image. Prefer a findingId (uses that finding's stored click marker). Or pass x_pct/y_pct in [0,1] when pointing at something without a finding.",
    parameters: {
      type: "object",
      properties: {
        findingId: { type: "string", description: "Optional finding whose marker to point at" },
        x_pct: { type: "number", description: "Normalized X in [0,1]" },
        y_pct: { type: "number", description: "Normalized Y in [0,1]" },
      },
    },
  },
  {
    name: "scroll_to",
    description:
      "Scroll the stack to an authored slice index from the finding's teaching guide. Never invent an index — copy it from guide=[scroll→N].",
    parameters: {
      type: "object",
      properties: {
        sliceIndex: { type: "number", description: "0-based stack index from the guide" },
        seriesInstanceUID: { type: "string", description: "Series UID when the guide switches series" },
        findingId: { type: "string" },
      },
      required: ["sliceIndex"],
    },
  },
  {
    name: "zoom_to",
    description:
      "Zoom (and optionally pan) to the magnification on the finding's teaching guide. Copy guide=[zoom(N)]. This is how a consultant leans in on a nodule — never invent a zoom.",
    parameters: {
      type: "object",
      properties: {
        zoom: { type: "number", description: "Magnification from the guide, e.g. 2.2" },
        panX: { type: "number" },
        panY: { type: "number" },
        findingId: { type: "string" },
      },
      required: ["zoom"],
    },
  },
  {
    name: "set_zoom",
    description:
      "Alias of zoom_to. Zoom (and optionally pan) to a magnification from the finding's teaching guide. Prefer zoom_to.",
    parameters: {
      type: "object",
      properties: {
        zoom: { type: "number" },
        panX: { type: "number" },
        panY: { type: "number" },
      },
      required: ["zoom"],
    },
  },
  {
    name: "set_invert",
    description: "Invert or restore the grayscale, matching an invert step in the teaching guide.",
    parameters: {
      type: "object",
      properties: { value: { type: "boolean" } },
      required: ["value"],
    },
  },
  {
    name: "draw_annotation",
    description:
      "Draw the consultant's stored measurement or arrow. Prefer findingId (replays every draw() on that finding's guide). Otherwise pass tool plus normalized endpoints copied from the guide — never invent coordinates.",
    parameters: {
      type: "object",
      properties: {
        findingId: { type: "string" },
        tool: { type: "string", description: "Length, EllipticalROI, ArrowAnnotate, Probe, Angle" },
        x_pct: { type: "number" },
        y_pct: { type: "number" },
        x2_pct: { type: "number" },
        y2_pct: { type: "number" },
      },
    },
  },
  {
    name: "play_guide",
    description:
      "Perform the finding's consultant walk-through in order (scroll, window, zoom, hold, point, measure) while you speak. Prefer this over inventing scroll_to / zoom_to. Pass the finding id.",
    parameters: {
      type: "object",
      properties: {
        findingId: { type: "string", description: "Finding id whose guide=[…] to perform" },
      },
      required: ["findingId"],
    },
  },
];

export const HARNESS_VIEWER_TOOLS: HarnessToolDeclaration[] = HARNESS_VIEWER_TOOL_BASE.map(
  (tool) => ({
    ...tool,
    description: tool.description.includes(SPOKEN_ANSWER_TOOL_CLAUSE)
      ? tool.description
      : `${tool.description.trim()} ${SPOKEN_ANSWER_TOOL_CLAUSE}`,
  })
);

/** Map a model function call into a typed viewer action. */
export function harnessActionFromCall(call?: {
  name: string;
  args: Record<string, unknown>;
}): HarnessViewerAction {
  if (!call) return { type: "none" };
  switch (call.name) {
    case "show_finding":
      return { type: "show_finding", findingId: String(call.args.findingId ?? "") };
    case "next_in_tour":
      return { type: "next_in_tour" };
    case "prev_in_tour":
      return { type: "prev_in_tour" };
    case "set_window":
      return {
        type: "set_window",
        windowWidth: Number(call.args.windowWidth),
        windowCenter: Number(call.args.windowCenter),
      };
    case "point_to": {
      const findingId =
        call.args.findingId != null ? String(call.args.findingId) : undefined;
      const x = call.args.x_pct != null ? Number(call.args.x_pct) : undefined;
      const y = call.args.y_pct != null ? Number(call.args.y_pct) : undefined;
      return {
        type: "point_to",
        findingId,
        x_pct: Number.isFinite(x) ? x : undefined,
        y_pct: Number.isFinite(y) ? y : undefined,
      };
    }
    case "scroll_to": {
      const sliceIndex = Number(call.args.sliceIndex);
      if (!Number.isFinite(sliceIndex)) return { type: "none" };
      const series =
        call.args.seriesInstanceUID != null
          ? String(call.args.seriesInstanceUID)
          : undefined;
      const findingId =
        call.args.findingId != null ? String(call.args.findingId) : undefined;
      return {
        type: "scroll_to",
        sliceIndex: Math.round(sliceIndex),
        seriesInstanceUID: series || undefined,
        findingId,
      };
    }
    case "set_series":
      return parseSetSeriesArgs(call.args) ?? { type: "none" };
    case "zoom_to":
    case "set_zoom": {
      const zoom = Number(call.args.zoom);
      if (!Number.isFinite(zoom) || zoom <= 0) return { type: "none" };
      const panX = call.args.panX != null ? Number(call.args.panX) : undefined;
      const panY = call.args.panY != null ? Number(call.args.panY) : undefined;
      return {
        type: "zoom_to",
        zoom,
        panX: Number.isFinite(panX) ? panX : undefined,
        panY: Number.isFinite(panY) ? panY : undefined,
      };
    }
    case "set_invert":
      return { type: "set_invert", value: Boolean(call.args.value) };
    case "draw_annotation": {
      const num = (k: string) => {
        const n = call.args[k] != null ? Number(call.args[k]) : undefined;
        return n != null && Number.isFinite(n) ? n : undefined;
      };
      return {
        type: "draw_annotation",
        findingId:
          call.args.findingId != null ? String(call.args.findingId) : undefined,
        tool: call.args.tool != null ? String(call.args.tool) : undefined,
        x_pct: num("x_pct"),
        y_pct: num("y_pct"),
        x2_pct: num("x2_pct"),
        y2_pct: num("y2_pct"),
      };
    }
    case "play_guide": {
      const findingId = String(call.args.findingId ?? "").trim();
      if (!findingId) return { type: "none" };
      return { type: "play_guide", findingId };
    }
    default:
      return { type: "none" };
  }
}
