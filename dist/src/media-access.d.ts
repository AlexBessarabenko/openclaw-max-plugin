/** Cap media downloads: senders and reply payloads control both count and size. */
export declare const MAX_INBOUND_ATTACHMENTS = 10;
export declare const MAX_ATTACHMENT_BYTES: number;
type FetchLike = (input: any, init?: any) => Promise<Response>;
/** Attachment larger than the per-file limit; thrown before buffering. */
export declare class MediaTooLargeError extends Error {
    readonly limitBytes: number;
    constructor(limitBytes: number, detail?: string);
}
/** Host-supplied file access, as it arrives on outbound send contexts. */
export type MediaAccessContext = {
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    mediaLocalRoots?: readonly string[];
};
export declare function isPathInsideRoots(filePath: string, roots: readonly string[]): boolean;
/**
 * Read a local file only through the reader the host provides, or from inside
 * the roots it allows. Without either, reading is refused: an agent can put an
 * arbitrary path in a media field, and the gateway config sits on the same disk.
 */
export declare function readLocalMedia(filePath: string, ctx: MediaAccessContext): Promise<Buffer>;
/**
 * Download remote media through the SDK SSRF guard, enforcing `maxBytes`
 * BEFORE buffering: a declared Content-Length over the limit aborts before the
 * body is read; without one the body stream is cut off at the limit. The
 * plugin's scoped fetch (MAX CA trust + optional proxy) stays in effect via
 * `fetchImpl`; the guard applies to whatever URL the platform handed us.
 */
export declare function downloadRemoteMedia(params: {
    url: string;
    fetchImpl: FetchLike;
    headers?: Record<string, string>;
    maxBytes?: number;
    timeoutMs?: number;
}): Promise<{
    buffer: Buffer;
    contentType: string;
}>;
export {};
//# sourceMappingURL=media-access.d.ts.map