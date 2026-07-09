import { redirect } from "next/navigation";

// /author is retired in favour of the single Studio teaching home. Old links
// (nav bookmarks, `/author?case=X`) still resolve correctly.
export default function AuthorRedirectPage({
  searchParams,
}: {
  searchParams: { case?: string };
}) {
  if (searchParams?.case) {
    redirect(`/studio/cases/${encodeURIComponent(searchParams.case)}`);
  }
  redirect("/studio");
}
