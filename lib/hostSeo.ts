import type { Metadata, MetadataRoute } from "next";

export const LEARN_ORIGIN = "https://learn.flowrad.ai";
export const VIEWER_ORIGIN = "https://app.viewer.flowrad.ai";

export function normalizeHost(host: string | null): string {
  return (host ?? "").toLowerCase().replace(/:\d+$/, "");
}

export function publicOrigin(host: string | null): string | null {
  switch (normalizeHost(host)) {
    case "learn.flowrad.ai": return LEARN_ORIGIN;
    case "app.viewer.flowrad.ai": return VIEWER_ORIGIN;
    default: return null;
  }
}

export const AI_SEARCH_CRAWLERS = [
  "OAI-SearchBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User",
  "PerplexityBot", "Perplexity-User", "DuckAssistBot", "MistralAI-User",
  "GPTBot", "ClaudeBot", "Google-Extended",
];

// Static route prefixes only: never enumerate studies, patients or share tokens.
export const PRIVATE_PATHS = [
  "/api/", "/admin", "/author", "/studio", "/dashboard", "/sign-in", "/sign-up",
  "/s/", "/record", "/dev", "/case/", "/upload", "/learning", "/library",
  "/course/", "/playlist/", "/certificate/", "/cornerstone", "/viewer/local",
];

export function robotsForHost(host: string | null): MetadataRoute.Robots {
  const origin = publicOrigin(host);
  if (!origin) return { rules: { userAgent: "*", disallow: "/" } };
  const disallow = [...PRIVATE_PATHS];
  if (origin === VIEWER_ORIGIN) disallow.push("/privacy", "/terms");
  return {
    rules: ["*", ...AI_SEARCH_CRAWLERS].map((userAgent) => ({
      userAgent, allow: "/", disallow: [...disallow],
    })),
    sitemap: `${origin}/sitemap.xml`,
  };
}

export function sitemapForHost(host: string | null): MetadataRoute.Sitemap {
  const origin = publicOrigin(host);
  if (!origin) return [];
  // /library serves an organisation's case locker, not a marketing page.
  const paths = origin === LEARN_ORIGIN ? ["/", "/privacy", "/terms"] : ["/viewer"];
  return paths.map((path) => ({ url: `${origin}${path}` }));
}

export function learnMetadataForHost(host: string | null): Metadata {
  const title = normalizeHost(host) === "learn.flowrad.ai" ? "RadLearn by FlowRad" : "RadLearn";
  const origin = publicOrigin(host);
  const description = "Teach radiology on the DICOM study. Record a case once. Registrars replay it with an AI tutor that drives scroll, window, and zoom.";
  return {
    title, description,
    ...(origin ? { metadataBase: new URL(origin) } : {}),
    openGraph: {
      title, description, type: "website",
      ...(origin ? { images: [`${origin}/opengraph-image`] } : {}),
    },
  };
}
