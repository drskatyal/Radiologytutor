/**
 * Registrar harness — tool surface the AI teammate may call to drive the
 * DICOM “computer”. Single source of truth; Gemini (and future models) import
 * this registry rather than declaring tools ad hoc.
 *
 * See docs/HARNESS.md (Grok Bot parallel: tools on a persistent computer).
 */

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
  | { type: "none" };

/** Gemini / OpenAPI-style function declarations for the tutor. */
export const HARNESS_VIEWER_TOOLS: HarnessToolDeclaration[] = [
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
];

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
    default:
      return { type: "none" };
  }
}
