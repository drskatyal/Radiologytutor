import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Role-aware hub — one click after sign-in.
 * Super-admin → console; teacher/author → studio; else library.
 */
export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");

  if (session.user.platformRole === "super_admin") {
    redirect("/admin");
  }

  // Membership lookup lands in a follow-up; email domain / name heuristics avoided.
  // Teachers use Studio; learners use Library. Studio stays reachable for all signed-in.
  redirect("/studio");
}
