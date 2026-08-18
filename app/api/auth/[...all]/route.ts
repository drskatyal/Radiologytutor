import { authHandlers } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE } = authHandlers;
