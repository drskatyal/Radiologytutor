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

export {
  applyActions,
  formatContract,
  formatScorecard,
  guideStepIsGating,
  harnessContractHeld,
  humanTeachActions,
  loadTutorFixture,
  parseTutorFixture,
  resolveTeachingGuide,
  scoreTutorSession,
  teachingGuideFromTrack,
  textOnlyTutor,
  viewerDrivingTutor,
  VOI_TOLERANCE,
  ZOOM_TOLERANCE,
  type BeatFidelity,
  type EvalAction,
  type FidelityPhase,
  type FutureViewerAction,
  type SessionScore,
  type TeachingGuideStep,
  type TutorAgent,
  type TutorEvalFixture,
  type TutorTurn,
} from "./tutorEval";
