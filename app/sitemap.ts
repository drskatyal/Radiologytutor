import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { sitemapForHost } from "@/lib/hostSeo";

export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapForHost(headers().get("host"));
}
