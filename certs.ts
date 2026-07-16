import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

/**
 * MAX API (platform-api2.max.ru) is served with a certificate chained to the
 * Russian national root CA ("Russian Trusted Root CA" / Минцифры), which is
 * absent from Node's bundled CA list. The PEM files are shipped in `certs/`
 * (also installable system-wide into /usr/local/share/ca-certificates/mincifry).
 */
const CERT_FILES = [
  "russian_trusted_root_ca_pem.crt",
  "russian_trusted_sub_ca_pem.crt",
  "russian_trusted_sub_ca_2024_pem.crt",
];

const FALLBACK_DIR = "/usr/local/share/ca-certificates/mincifry";

let installed = false;

type CertLogger = { info?: (msg: string) => void; warn?: (msg: string) => void };

export function ensureRussianTrustedCAs(logger?: CertLogger): void {
  if (installed) return;
  installed = true;

  if (
    typeof (tls as any).setDefaultCACertificates !== "function" ||
    typeof (tls as any).getCACertificates !== "function"
  ) {
    logger?.warn?.(
      "[MAX] This Node.js version cannot extend CAs at runtime. " +
        "Restart with NODE_EXTRA_CA_CERTS pointing at certs/russian_trusted_root_ca_pem.crt"
    );
    return;
  }

  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [join(pluginRoot, "certs"), FALLBACK_DIR];

  const extra: string[] = [];
  for (const dir of candidates) {
    for (const file of CERT_FILES) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      try {
        extra.push(readFileSync(path, "utf8"));
      } catch {
        // try next directory
      }
    }
    if (extra.length > 0) break;
  }

  if (extra.length === 0) {
    logger?.warn?.("[MAX] Russian Trusted CA certificates not found; TLS to platform-api2.max.ru may fail");
    return;
  }

  try {
    (tls as any).setDefaultCACertificates([...(tls as any).getCACertificates("default"), ...extra]);
    logger?.info?.(`[MAX] Russian Trusted CA bundle installed (${extra.length} certificates)`);
  } catch (err) {
    logger?.warn?.(`[MAX] Failed to install Russian Trusted CAs: ${(err as Error).message}`);
  }
}
