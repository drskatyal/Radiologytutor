import { createDemoSessionResponse, clearDemoSessionResponse } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Demo/dev sign-in — no Google keys required. */
export async function POST() {
  return createDemoSessionResponse();
}

export async function DELETE() {
  return clearDemoSessionResponse();
}
