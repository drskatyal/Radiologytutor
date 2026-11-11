import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { seoForRequest } from "@/lib/hostSeo";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return (await seoForRequest(headers())).sitemap;
}
