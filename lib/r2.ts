// Cloudflare R2 seam — S3-compatible object storage for audio + cached frames.
// When unset, callers keep using local disk / Orthanc. Never required at build.

export function r2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID?.trim() &&
      process.env.R2_ACCESS_KEY_ID?.trim() &&
      process.env.R2_SECRET_ACCESS_KEY?.trim() &&
      process.env.R2_BUCKET?.trim()
  );
}

function endpoint(): string {
  const account = process.env.R2_ACCOUNT_ID!.trim();
  return `https://${account}.r2.cloudflarestorage.com`;
}

function publicBase(): string | null {
  const b = process.env.R2_PUBLIC_BASE_URL?.trim();
  return b ? b.replace(/\/$/, "") : null;
}

/**
 * Public or path URL for an object. Prefer R2_PUBLIC_BASE_URL (custom domain /
 * r2.dev). Without it, returns a path-style key hint for the app proxy.
 */
export function r2ObjectUrl(key: string): string {
  const clean = key.replace(/^\//, "");
  const base = publicBase();
  if (base) return `${base}/${clean}`;
  return `/api/r2/${clean}`;
}

/**
 * Put bytes into R2 using the S3-compatible PutObject API (AWS Signature V4
 * via fetch is non-trivial). When the official SDK is available we use it;
 * otherwise this no-ops with a clear error so local/dev without R2 still runs.
 */
export async function r2PutObject(
  key: string,
  body: Buffer,
  contentType: string
): Promise<{ key: string; url: string }> {
  if (!r2Configured()) {
    throw new Error("R2 is not configured");
  }
  try {
    // Dynamic import keeps build light when the SDK isn't needed at compile time.
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: "auto",
      endpoint: endpoint(),
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET!,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
    return { key, url: r2ObjectUrl(key) };
  } catch (e) {
    if (
      e instanceof Error &&
      (e.message.includes("Cannot find module") || e.message.includes("R2 is not"))
    ) {
      throw e;
    }
    throw new Error(
      `R2 put failed: ${e instanceof Error ? e.message : "unknown error"}`
    );
  }
}

export async function r2GetObject(
  key: string
): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!r2Configured()) return null;
  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: "auto",
      endpoint: endpoint(),
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
    const out = await client.send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET!,
        Key: key,
      })
    );
    if (!out.Body) return null;
    const bytes = Buffer.from(await out.Body.transformToByteArray());
    return {
      bytes,
      contentType: out.ContentType || "application/octet-stream",
    };
  } catch {
    return null;
  }
}
