import { redirect } from "next/navigation";

// /studio -> My cases (the default Studio tab). Forced dynamic: a redirect()
// in a page with no dynamic dependencies gets statically optimized, which
// bakes an HTML shell instead of a real HTTP redirect — a hard navigation
// (bookmark, curl, crawler) would then never leave the page. This route
// exists purely to redirect, so make every request go through the server.
export const dynamic = "force-dynamic";

export default function StudioIndexPage() {
  redirect("/studio/cases");
}
