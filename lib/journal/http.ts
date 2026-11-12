import { NextResponse } from "next/server";
import { jsonAuthError } from "../auth";
import { CaptureError } from "./manifest";
import { PhiError } from "../phiGuard";
export function captureHttpError(error: unknown): Response {
  return jsonAuthError(error) ?? NextResponse.json({ error: error instanceof CaptureError || error instanceof PhiError ? error.message : "Capture operation failed; retry from retained local data." }, { status: error instanceof CaptureError || error instanceof PhiError ? error.status : 500 });
}
