import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which build is serving: the git commit baked into the image (GIT_SHA build
 * arg: Dockerfile, deploy/gcp/cloudbuild.yaml, deploy/gcp/deploy-app.sh) and,
 * on Cloud Run, the revision. Public and harmless: no config, no secrets.
 */
export async function GET() {
  return NextResponse.json(
    {
      commit: process.env.GIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || null,
      revision: process.env.K_REVISION || process.env.RAILWAY_DEPLOYMENT_ID || null,
      service: process.env.K_SERVICE || null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
