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
    host?.toLowerCase().replace(/:\d+$/, "") !== "app.viewer.flowrad.ai" ||
    requestUrl.pathname !== "/"
  ) return null;

  const url = requestUrl.clone();
  url.pathname = "/viewer";
  return { url, status: 302 };
}
