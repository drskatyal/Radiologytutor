import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { robotsForHost } from "@/lib/hostSeo";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return robotsForHost(headers().get("host"));
}
