import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Unit tests for the media access layer: SSRF guard wiring, the pre-buffering
 * size limit, and local-path confinement. The SDK guard is mocked to a
 * pass-through so tests can observe what it was called with; no network.
 */

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(async ({ url, fetchImpl, init }: any) => {
    const response = await fetchImpl(url, init);
    return { response, finalUrl: url, release: async () => {} };
  }),
}));

import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  downloadRemoteMedia,
  isPathInsideRoots,
  MediaTooLargeError,
  readLocalMedia,
} from "./media-access.js";

function fakeResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    headers: new Headers({ "content-type": "application/octet-stream" }),
    body: null,
    arrayBuffer: vi.fn(async () => new TextEncoder().encode("payload").buffer),
    ...overrides,
  } as any;
}

function streamOf(chunkSizes: number[]) {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls >= chunkSizes.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunkSizes[pulls]));
      pulls++;
    },
  });
  return { stream, pulls: () => pulls };
}

describe("downloadRemoteMedia", () => {
  it("routes through the SSRF guard with the scoped fetch and headers", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse());
    const { buffer } = await downloadRemoteMedia({
      url: "https://cdn.max.ru/file.bin",
      fetchImpl,
      headers: { Authorization: "Bearer tok" },
    });
    expect(buffer.toString()).toBe("payload");
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://cdn.max.ru/file.bin", fetchImpl }),
    );
    expect(fetchImpl).toHaveBeenCalledWith("https://cdn.max.ru/file.bin", {
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("refuses a declared oversize Content-Length before touching the body", async () => {
    const response = fakeResponse({
      headers: new Headers({ "content-length": String(26 * 1024 * 1024) }),
    });
    const fetchImpl = vi.fn(async () => response);
    await expect(
      downloadRemoteMedia({ url: "https://cdn.max.ru/big.bin", fetchImpl }),
    ).rejects.toBeInstanceOf(MediaTooLargeError);
    // The body was never buffered.
    expect(response.arrayBuffer).not.toHaveBeenCalled();
  });

  it("cuts off a streamed body without Content-Length at the limit", async () => {
    const { stream, pulls } = streamOf([60, 60, 60, 60]);
    const fetchImpl = vi.fn(async () => fakeResponse({ body: stream }));
    await expect(
      downloadRemoteMedia({ url: "https://cdn.max.ru/stream.bin", fetchImpl, maxBytes: 100 }),
    ).rejects.toBeInstanceOf(MediaTooLargeError);
    // The stream is abandoned at the limit, never fully drained (the stream's
    // internal queue may prefetch one chunk ahead of the reader).
    expect(pulls()).toBeLessThan(4);
  });

  it("accepts a streamed body within the limit", async () => {
    const { stream } = streamOf([40, 40]);
    const fetchImpl = vi.fn(async () => fakeResponse({ body: stream }));
    const { buffer } = await downloadRemoteMedia({
      url: "https://cdn.max.ru/ok.bin",
      fetchImpl,
      maxBytes: 100,
    });
    expect(buffer.byteLength).toBe(80);
  });
});

describe("readLocalMedia confinement", () => {
  it("refuses paths outside the allowed roots", async () => {
    await expect(
      readLocalMedia("/etc/passwd", { mediaLocalRoots: [os.tmpdir()] }),
    ).rejects.toThrow(/outside the media roots/);
  });

  it("refuses everything when no roots and no host reader are available", async () => {
    await expect(readLocalMedia("/tmp/whatever.bin", {})).rejects.toThrow(
      /outside the media roots/,
    );
  });

  it("prefers the host-provided reader over root checks", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("host-read"));
    const buf = await readLocalMedia("/anywhere/file.bin", { mediaReadFile });
    expect(buf.toString()).toBe("host-read");
    expect(mediaReadFile).toHaveBeenCalledWith("/anywhere/file.bin");
  });

  it("reads a file inside an allowed root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "max-media-"));
    const file = path.join(root, "note.txt");
    fs.writeFileSync(file, "hello");
    const buf = await readLocalMedia(file, { mediaLocalRoots: [root] });
    expect(buf.toString()).toBe("hello");
  });
});

describe("isPathInsideRoots", () => {
  it("matches the root itself and nested paths, not siblings", () => {
    const root = path.join(os.tmpdir(), "root");
    expect(isPathInsideRoots(path.join(root, "a.bin"), [root])).toBe(true);
    expect(isPathInsideRoots(root, [root])).toBe(true);
    expect(isPathInsideRoots(root + "-evil", [root])).toBe(false);
    expect(isPathInsideRoots(path.join(root, "..", "etc", "passwd"), [root])).toBe(false);
  });
});
