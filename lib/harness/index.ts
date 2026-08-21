/**
 * FlowRad registrar harness — environment + tools + demonstration merge.
 * Models (STT / tutor / TTS) plug in; they do not own the DICOM computer.
 */

export {
  HARNESS_VIEWER_TOOLS,
  harnessActionFromCall,
  type HarnessViewerAction,
} from "./tools";

export {
  mergeCaptureDemonstration,
  type MergeCaptureInput,
  type MergedCapture,
} from "./mergeCapture";
