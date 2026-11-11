import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { seoForRequest } from "@/lib/hostSeo";

export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  return (await seoForRequest(headers())).robots;
}
