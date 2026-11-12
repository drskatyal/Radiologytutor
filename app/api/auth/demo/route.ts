import {
  clearDemoSessionResponse,
  createDemoSessionResponse,
  type DemoRole,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Demo/dev sign-in — no Google keys required.
 *  Body `{ role: "student" | "author" | "super_admin" }`. An empty body is the
 *  implicit demo (super-admin in local dev, student in production).
 *  Production refuses an explicit author/admin request with 403: anonymous
 *  role elevation in the shared demo org is not a thing (lib/demoEntry.ts).
 */
export async function POST(req: Request) {
  let role: DemoRole = "super_admin";
  let explicit = false;
  try {
    const body = (await req.json()) as { role?: string };
    if (typeof body.role === "string" && body.role.trim()) explicit = true;
    if (body.role === "student") role = "student";
    else if (body.role === "author" || body.role === "teacher") role = "author";
    else if (body.role === "super_admin" || body.role === "admin") role = "super_admin";
    else if (explicit) role = "super_admin"; // unknown names are treated as elevated
  } catch {
    // Empty body → implicit demo.
  }
  return createDemoSessionResponse(role, explicit);
}

export async function DELETE() {
  return clearDemoSessionResponse();
}
