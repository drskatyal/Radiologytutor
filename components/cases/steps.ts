// The single case-creation arc's 4 steps, shared by CreateCaseFlow (steps 1-2)
// and RecordingStudio (steps 3-4) so the SAME Stepper rail renders across both
// routes — the journey reads as one continuous flow, not a modal + a
// disconnected page.

export type CaseFlowStepId = "details" | "upload" | "record" | "publish";

export const CASE_FLOW_STEPS: { id: CaseFlowStepId; label: string; caption: string }[] = [
  { id: "details", label: "Details", caption: "Stem, diagnosis, pedagogy" },
  { id: "upload", label: "Upload DICOM", caption: "Study & series" },
  { id: "record", label: "Record findings", caption: "Voice walk-through" },
  { id: "publish", label: "Review & publish", caption: "Confirm & release" },
];
