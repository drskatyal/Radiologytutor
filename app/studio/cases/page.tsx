import { redirect } from "next/navigation";
import { MyCasesList } from "@/components/studio/MyCasesList";
import { getSession } from "@/lib/auth";

export const metadata = {
  title: "My cases · Studio · FlowRad Learn",
};

export const dynamic = "force-dynamic";

export default async function StudioCasesPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return <MyCasesList />;
}
