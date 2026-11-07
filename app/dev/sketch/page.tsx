import { notFound } from "next/navigation";
import { SketchPreview } from "@/components/student/SketchPreview";

export default function SketchPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <SketchPreview />;
}
