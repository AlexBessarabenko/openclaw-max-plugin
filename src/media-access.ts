import fs from "node:fs";
import path from "node:path";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

/** Cap media downloads: senders and reply payloads control both count and size. */
export const MAX_INBOUND_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type FetchLike = (input: any, init?: any) => Promise<Response>;

/** Attachment larger than the per-file limit; thrown before buffering. */
export class MediaTooLargeError extends Error {
  constructor(
    public readonly limitBytes: number,
    detail?: string,
  ) {
    super(
      `attachment exceeds the ${Math.round(limitBytes / 1024 / 1024)} MB limit` +
        (detail ? ` (${detail})` : ""),
    );
    this.name = "MediaTooLargeError";
  }
}

/** Host-supplied file access, as it arrives on outbound send contexts. */
export type MediaAccessContext = {
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  mediaLocalRoots?: readonly string[];
};

export function isPathInsideRoots(filePath: string, roots: readonly string[]): boolean {
  if (!roots.length) return false;
  const resolved = path.resolve(filePath);
  return roots.some((root) => {
    const normalized = path.resolve(root);
    return resolved === normalized || resolved.startsWith(normalized + path.sep);
  });
}

/**
 * Read a local file only through the reader the host provides, or from inside
 * the roots it allows. Without either, reading is refused: an agent can put an
 * arbitrary path in a media field, and the gateway config sits on the same disk.
 */
export async function readLocalMedia(
  filePath: string,
  ctx: MediaAccessContext,
): Promise<Buffer> {
  if (ctx.mediaReadFile) return ctx.mediaReadFile(filePath);
  if (!isPathInsideRoots(filePath, ctx.mediaLocalRoots ?? [])) {
    throw new Error(
      `refusing to read "${filePath}": outside the media roots allowed for this send`,
    );
  }
  return fs.promises.readFile(filePath);
}

/**
 * Download remote media through the SDK SSRF guard, enforcing `maxBytes`
 * BEFORE buffering: a declared Content-Length over the limit aborts before the
 * body is read; without one the body stream is cut off at the limit. The
 * plugin's scoped fetch (MAX CA trust + optional proxy) stays in effect via
 * `fetchImpl`; the guard applies to whatever URL the platform handed us.
 */
export async function downloadRemoteMedia(params: {
  url: string;
  fetchImpl: FetchLike;
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<{ buffer: Buffer; contentType: string }> {
  const limit = params.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    fetchImpl: params.fetchImpl as any,
    init: params.headers ? { headers: params.headers } : undefined,
    timeoutMs: params.timeoutMs ?? 60_000,
  });
  try {
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > limit) {
      throw new MediaTooLargeError(limit, `Content-Length ${declared}`);
    }
    if (!response.body) {
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.byteLength > limit) {
        throw new MediaTooLargeError(limit, `${buf.byteLength} bytes`);
      }
      return { buffer: buf, contentType };
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new MediaTooLargeError(limit, `stream cut off at ${limit} bytes`);
      }
      if (value) chunks.push(Buffer.from(value));
    }
    return { buffer: Buffer.concat(chunks), contentType };
  } finally {
    await release();
  }
}
