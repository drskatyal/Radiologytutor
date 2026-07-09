"use client";

import { CaseEditor } from "@/components/studio/CaseEditor";

export default function StudioCaseEditorPage({ params }: { params: { caseId: string } }) {
  // Key on caseId so switching cases fully remounts the workspace state.
  return <CaseEditor key={params.caseId} caseId={params.caseId} />;
}
