// Process liveness only. No auth, environment, database or provider dependency.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };

export function GET(): Response {
  return Response.json({ status: "ok" }, { headers });
}

export function HEAD(): Response {
  return new Response(null, { status: 200, headers });
}
