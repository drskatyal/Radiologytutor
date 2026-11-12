import { notFound } from "next/navigation";
import { TeachingLayerDemo } from "@/components/viewer/TeachingLayerDemo";

// The teaching-layer seam on the shared viewer frame (lib/teachingLayer.ts).
// A development fixture, not a product page: hidden in production unless the
// test server opts in (playwright.visual.config.ts sets FLOWRAD_DEV_ROUTES).
export const dynamic = "force-dynamic";

export const metadata = { title: "Teaching layer (dev)", robots: { index: false } };

export default function TeachingLayerPage() {
  if (process.env.NODE_ENV === "production" && process.env.FLOWRAD_DEV_ROUTES !== "1") notFound();
  return <TeachingLayerDemo />;
}
