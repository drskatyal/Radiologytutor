import { normalizeHost, VIEWER_ORIGIN } from "./hostSeo";

interface CloneableUrl<T> {
  pathname: string;
  clone(): T;
}

/** Temporary root entry point for the app viewer host only. */
export function viewerHostRedirect<T extends CloneableUrl<T>>(
  host: string | null,
  requestUrl: T,
): { url: T; status: 302 } | null {
  if (
    normalizeHost(host) !== "app.viewer.flowrad.ai" ||
    requestUrl.pathname !== "/"
  ) return null;

  const url = requestUrl.clone();
  url.pathname = "/viewer";
  return { url, status: 302 };
}

/** Permanent hand-off from the learn host to the free viewer, preserving search. */
export function learnViewerRedirect(
  host: string | null,
  requestUrl: { pathname: string; search: string },
): { url: URL; status: 301 } | null {
  if (normalizeHost(host) !== "learn.flowrad.ai" || requestUrl.pathname !== "/viewer") return null;
  const url = new URL("/viewer", VIEWER_ORIGIN);
  url.search = requestUrl.search;
  return { url, status: 301 };
}
