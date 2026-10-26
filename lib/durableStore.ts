// Cloud Run has no durable disk. The JSON-on-volume store is the dev, test,
// and local-demo fallback. A Cloud Run revision (K_SERVICE is set by the
// platform) must use MongoDB via MONGODB_URI from Secret Manager.

/** Throw when this process is Cloud Run and MONGODB_URI is missing. */
export function assertCloudRunMongo(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.K_SERVICE?.trim()) return;
  if (env.MONGODB_URI?.trim()) return;
  throw new Error(
    "Cloud Run requires MONGODB_URI from Secret Manager. JSON-on-disk is not durable on Cloud Run."
  );
}
