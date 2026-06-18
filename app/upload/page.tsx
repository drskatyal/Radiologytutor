// The standalone upload page has been folded into the admin create-case flow
// (/admin → "New case"), where an upload is captured as a Case + Patient +
// Study in one step. Keep this route as a redirect so old links still work.

import { redirect } from "next/navigation";

export default function UploadPage() {
  redirect("/admin");
}
