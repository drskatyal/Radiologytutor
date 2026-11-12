// Shared private GCS JSON API transport, extracted from the existing bundle store.
// Authentication stays server-side; no signed/public object URLs or HMAC keys.
import { gcpAccessToken } from "./gcpAuth";
import type { BundleStore } from "./dicomCdn/store";

const GCS = "https://storage.googleapis.com";

export function openGcsStore(bucket: string): BundleStore & { getObject(key: string): Promise<{ bytes: Buffer; contentType: string } | null> } {
  const object = (key: string) =>
    `${GCS}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`;
  const auth = async () => ({ Authorization: `Bearer ${await gcpAccessToken()}` });

  return {
    async getObject(key) {
      const res = await fetch(`${object(key)}?alt=media`, { headers: await auth(), cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GCS get -> ${res.status}`);
      return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "application/octet-stream" };
    },
    async put(key, body, opts) {
      // Multipart upload so Cache-Control is set in the same request.
      const boundary = `radlearn${Math.random().toString(36).slice(2)}`;
      const meta = JSON.stringify({
        name: key,
        contentType: opts.contentType,
        cacheControl: opts.cacheControl,
      });
      const head = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
          `--${boundary}\r\nContent-Type: ${opts.contentType}\r\n\r\n`,
        "utf8"
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
      const res = await fetch(
        `${GCS}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=multipart`,
        {
          method: "POST",
          headers: {
            ...(await auth()),
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body: Buffer.concat([head, Buffer.from(body.buffer, body.byteOffset, body.byteLength), tail]),
          cache: "no-store", signal: AbortSignal.timeout(30_000),
        }
      );
      if (!res.ok) throw new Error(`GCS put -> ${res.status}`);
    },
    async get(key) {
      const res = await fetch(`${object(key)}?alt=media`, { headers: await auth(), cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GCS get -> ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async getRange(key, start, end) {
      const res = await fetch(`${object(key)}?alt=media`, {
        headers: { ...(await auth()), Range: `bytes=${start}-${end}` },
        cache: "no-store", signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GCS get -> ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return res.status === 206 ? bytes : bytes.subarray(start, end + 1);
    },
    async list(prefix) {
      const out: string[] = [];
      let pageToken = "";
      do {
        const params = new URLSearchParams({ prefix, fields: "items(name),nextPageToken" });
        if (pageToken) params.set("pageToken", pageToken);
        const res = await fetch(`${GCS}/storage/v1/b/${encodeURIComponent(bucket)}/o?${params}`, {
          headers: await auth(),
          cache: "no-store", signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`GCS list -> ${res.status}`);
        const body = (await res.json()) as { items?: { name: string }[]; nextPageToken?: string };
        for (const item of body.items ?? []) out.push(item.name);
        pageToken = body.nextPageToken ?? "";
      } while (pageToken);
      return out;
    },
    async delete(key) {
      const res = await fetch(object(key), { method: "DELETE", headers: await auth(), cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (!res.ok && res.status !== 404) throw new Error(`GCS delete -> ${res.status}`);
    },
  };
}

