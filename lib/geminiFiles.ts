/**
 * Gemini Files API upload for a viewport recording.
 * The key stays on the server. Callers pass bytes; this module does not read
 * the request body itself.
 */

const UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta";
const FILE_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface UploadedGeminiFile {
  uri: string;
  mimeType: string;
  name: string;
}

function fileUriAllowed(uri: string): boolean {
  return uri.startsWith("https://generativelanguage.googleapis.com/");
}

/**
 * Resumable upload, then poll until the file is ACTIVE.
 * `fetchImpl` exists so tests can stub the two-step protocol.
 */
export async function uploadGeminiFile(input: {
  bytes: Uint8Array;
  mimeType: string;
  displayName?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<UploadedGeminiFile> {
  const key = input.apiKey ?? process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const fetchImpl = input.fetchImpl ?? fetch;
  const pause = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const mimeType = input.mimeType || "video/webm";

  const start = await fetchImpl(`${UPLOAD_BASE}/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(input.bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: input.displayName || "viewport" } }),
  });
  if (!start.ok) throw new Error(`Gemini file upload failed (${start.status})`);
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini file upload did not return an upload URL");

  const payload = new Uint8Array(input.bytes.byteLength);
  payload.set(input.bytes);
  const put = await fetchImpl(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(payload.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: new Blob([payload.buffer]),
  });
  if (!put.ok) throw new Error(`Gemini file upload failed (${put.status})`);
  const created = (await put.json()) as { file?: GeminiFileJson } & GeminiFileJson;
  let file = readFile(created.file ?? created, mimeType);

  for (let attempt = 0; attempt < 60 && file.state === "PROCESSING"; attempt++) {
    await pause(2000);
    const poll = await fetchImpl(`${FILE_BASE}/${file.name}`, {
      headers: { "x-goog-api-key": key },
    });
    if (!poll.ok) throw new Error(`Gemini file status failed (${poll.status})`);
    const body = (await poll.json()) as { file?: GeminiFileJson } & GeminiFileJson;
    file = readFile(body.file ?? body, file.mimeType);
  }
  if (file.state !== "ACTIVE") throw new Error(`Gemini file was not ready (${file.state || "unknown"})`);
  if (!fileUriAllowed(file.uri)) throw new Error("Gemini file URI was not recognized");
  return { uri: file.uri, mimeType: file.mimeType, name: file.name };
}

interface GeminiFileJson {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: string;
}

function readFile(raw: GeminiFileJson, fallbackMime: string): Required<Pick<GeminiFileJson, "name" | "uri" | "mimeType" | "state">> {
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    uri: typeof raw.uri === "string" ? raw.uri : "",
    mimeType: typeof raw.mimeType === "string" && raw.mimeType ? raw.mimeType : fallbackMime,
    state: typeof raw.state === "string" && raw.state ? raw.state : "ACTIVE",
  };
}
