import { redirect } from "next/navigation";
import { activeOrgId, getSession } from "@/lib/auth";
import { listCasesForOrg } from "@/lib/cases";
import { dashboardPath } from "@/lib/dashboardPath";
import { selectLearnerStudy } from "@/lib/learnerEntry";
import { DashboardHub } from "@/components/dashboard/DashboardHub";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Your home · RadLearn",
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
  if (dest === "/library" && session?.user.membershipRole === "student") {
    try {
      const orgId = await activeOrgId();
      const study = selectLearnerStudy(await listCasesForOrg(orgId, { status: "published" }));
      if (study) redirect(`/case/${study.caseId}`);
    } catch {
      // The library remains the fallback when the catalog cannot be read.
    }
  }
  if (dest) redirect(dest);

  return <DashboardHub email={session?.user.email} name={session?.user.name} />;
}
