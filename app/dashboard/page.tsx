import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { dashboardPath } from "@/lib/dashboardPath";
import { DashboardHub } from "@/components/dashboard/DashboardHub";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Your home · FlowRad Learn",
};

/**
 * Role-aware hub after sign-in.
 * Super-admin / org admin → Admin; author → Studio; student → Library;
 * signed-out → sign-in. When membership is not on the session yet, a stub
 * hub with explicit links is shown.
 */
export default async function DashboardPage() {
  const session = await getSession();
  const dest = dashboardPath({
    signedIn: Boolean(session),
    platformRole: session?.user.platformRole,
    membershipRole: session?.user.membershipRole,
  });
  if (dest) redirect(dest);

  return <DashboardHub email={session?.user.email} name={session?.user.name} />;
}
