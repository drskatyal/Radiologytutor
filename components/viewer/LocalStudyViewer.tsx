"use client";

// The FlowRad free viewer over files from this computer: the shared reading
// frame (ViewerFrame) with the local source adapter. Kept as its own name so
// existing imports, marks and tests read the same; new code renders
// <ViewerFrame source={...}> directly.

import { ViewerFrame, type LocalViewerTone } from "./ViewerFrame";

export {
  FILES_RECEIVED_MARK,
  FIRST_IMAGE_DECODED_MARK,
  FIRST_IMAGE_REGISTERED_MARK,
  STUDY_PARSED_MARK,
  type LocalViewerTone,
  type ViewerMemoryStats,
} from "./ViewerFrame";

const LOCAL = { kind: "local" } as const;

export function LocalStudyViewer({ tone = "page" }: { tone?: LocalViewerTone }) {
  return <ViewerFrame tone={tone} source={LOCAL} />;
}

export default LocalStudyViewer;
