import {
  clearDemoSessionResponse,
  createDemoSessionResponse,
  type DemoRole,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Demo/dev sign-in — no Google keys required. Body `{ role: "student" }` for learner demo. */
export async function POST(req: Request) {
  let role: DemoRole = "super_admin";
  try {
    const body = (await req.json()) as { role?: string };
    if (body.role === "student") role = "student";
  } catch {
    // Empty body → super-admin demo (default).
  }
  return createDemoSessionResponse(role);
}

export async function DELETE() {
  return clearDemoSessionResponse();
}
