import { redirect } from "next/navigation";

// The recording studio moved to /studio/cases/[caseId]/record (steps 3-4 of
// the single create-a-case arc). Old links still resolve correctly.
export default function AuthorRecordRedirectPage({ params }: { params: { caseId: string } }) {
  redirect(`/studio/cases/${encodeURIComponent(params.caseId)}/record`);
}
