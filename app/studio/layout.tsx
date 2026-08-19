import { requirePageRole } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function StudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePageRole("author", "/studio");
  return children;
}
