import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";

/**
 * MAX API (platform-api2.max.ru) is served with a certificate chained to the
 * Russian national root CA ("Russian Trusted Root CA" / Минцифры), which is
 * absent from Node's bundled CA list. The PEM files are shipped in `certs/`.
 *
 * Instead of expanding the process-wide trust store
 * (tls.setDefaultCACertificates affects every plugin and channel in the
 * gateway), the extra CAs live on a dedicated undici dispatcher used ONLY for
 * requests to MAX infrastructure hosts (*.max.ru, *.oneme.ru). All other
 * traffic keeps Node's default trust.
 */
const CERT_FILES = [
  "russian_trusted_root_ca_pem.crt",
  "russian_trusted_sub_ca_pem.crt",
  "russian_trusted_sub_ca_2024_pem.crt",
];

const FALLBACK_DIR = "/usr/local/share/ca-certificates/mincifry";

/** Hosts whose certificate chains require the bundled Russian national CAs. */
const MAX_HOST_RE = /(^|\.)(max|oneme)\.ru$/i;

export function isMaxInfraHost(hostname: string): boolean {
  return MAX_HOST_RE.test(hostname);
}

type FetchLike = (input: any, init?: any) => Promise<any>;

let maxDispatcher: Agent | null | undefined;
let logged = false;

type CertLogger = { info?: (msg: string) => void; warn?: (msg: string) => void };

function loadExtraCAs(logger?: CertLogger): string[] {
  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [join(pluginRoot, "certs"), FALLBACK_DIR];

  for (const dir of candidates) {
    const pem: string[] = [];
    for (const file of CERT_FILES) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      try {
        pem.push(readFileSync(path, "utf8"));
      } catch {
        // try next directory
      }
    }
    if (pem.length > 0) return pem;
  }
  logger?.warn?.(
    "[MAX] Russian Trusted CA certificates not found; TLS to platform-api2.max.ru may fail",
  );
  return [];
}

function getMaxDispatcher(logger?: CertLogger): Agent | null {
  if (maxDispatcher !== undefined) return maxDispatcher;
  const extra = loadExtraCAs(logger);
  if (extra.length === 0 || typeof (tls as any).getCACertificates !== "function") {
    maxDispatcher = null;
    return maxDispatcher;
  }
  // The dispatcher's `ca` replaces the per-connection default, so include the
  // standard Mozilla store alongside the Russian national CAs.
  maxDispatcher = new Agent({
    connect: { ca: [...(tls as any).getCACertificates("default"), ...extra] },
  });
  if (!logged) {
    logged = true;
    logger?.info?.(
      `[MAX] Russian Trusted CAs (${extra.length}) loaded for MAX hosts only (process trust store unchanged)`,
    );
  }
  return maxDispatcher;
}

/**
 * fetch wrapper that routes MAX-infrastructure hosts through the CA-enriched
 * dispatcher and everything else through the untouched global fetch. Pass it
 * to the max-bot-api client (`clientOptions.fetch`) and use it for direct
 * calls (uploads, attachment downloads, probes).
 */
export function createMaxScopedFetch(logger?: CertLogger): FetchLike {
  return (input: any, init?: any) => {
    let host = "";
    try {
      host = new URL(typeof input === "string" ? input : (input?.url ?? String(input))).hostname;
    } catch {
      // unparsable URL: let the plain fetch surface the error
    }
    if (host && isMaxInfraHost(host)) {
      const dispatcher = getMaxDispatcher(logger);
      // Global fetch (not undici's own): it serializes the platform FormData/
      // Blob correctly, while still accepting a dispatcher for scoped TLS.
      if (dispatcher) return globalThis.fetch(input, { ...init, dispatcher });
    }
    return globalThis.fetch(input, init);
  };
}
