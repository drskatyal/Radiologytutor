// The standalone upload page has been folded into the single create-a-case
// flow (/studio/new), where an upload is captured as a Case + Patient + Study
// in one step. Keep this route as a redirect so old links still work.
//
// Forced dynamic: a redirect() in a page with no dynamic dependencies gets
// statically optimized, which bakes an HTML shell instead of a real HTTP
// redirect — a hard navigation (bookmark, curl, crawler) would then never
// leave the page.

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function UploadPage() {
  redirect("/studio/new");
}
