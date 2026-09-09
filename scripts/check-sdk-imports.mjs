#!/usr/bin/env node
/**
 * CI hygiene: verify that every `openclaw/plugin-sdk/*` subpath the built
 * plugin imports actually resolves against the installed openclaw package,
 * and that every named binding exists in the module namespace. Catches
 * upstream SDK moves/removals (ERR_PACKAGE_PATH_NOT_EXPORTED, missing
 * exports) before a gateway restart does.
 *
 * Also loads the built entry points (dist/index.js, dist/channel.js) the way
 * the gateway would and asserts their key exports are defined.
 *
 * Run after `npm run build`: npm run check:sdk
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js")) files.push(p);
  }
})(distDir);

// specifier → Set of named bindings our code imports from it
const specifiers = new Map();
const importRe =
  /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'](openclaw\/[^"']+)["']/g;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const match of src.matchAll(importRe)) {
    const names = match[1]
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    if (!specifiers.has(match[2])) specifiers.set(match[2], new Set());
    for (const name of names) specifiers.get(match[2]).add(name);
  }
}

let failed = false;
for (const [spec, names] of [...specifiers].sort(([a], [b]) => a.localeCompare(b))) {
  let mod;
  try {
    mod = await import(spec);
  } catch (err) {
    console.error(`✗ ${spec}: import failed: ${err?.code ?? err?.message ?? err}`);
    failed = true;
    continue;
  }
  const missing = [...names].filter((name) => !(name in mod));
  if (missing.length > 0) {
    console.error(`✗ ${spec}: missing exports: ${missing.join(", ")}`);
    failed = true;
  } else {
    console.log(`✓ ${spec} (${names.size} bindings)`);
  }
}

// Load the built entry points like the gateway loader does.
const expectations = {
  "dist/index.js": ["default", "handleUpdate"],
  "dist/channel.js": ["maxPlugin", "initializeBot", "sendMaxMessage"],
};
for (const [file, keys] of Object.entries(expectations)) {
  try {
    const mod = await import(join(distDir, file.replace(/^dist\//, "")));
    const missing = keys.filter((key) => !(key in mod));
    if (missing.length > 0) {
      console.error(`✗ ${file}: missing exports: ${missing.join(", ")}`);
      failed = true;
    } else {
      console.log(`✓ ${file} loads (${keys.join(", ")} defined)`);
    }
  } catch (err) {
    console.error(`✗ ${file}: load failed: ${err?.code ?? err?.message ?? err}`);
    failed = true;
  }
}

if (failed) {
  console.error("\nSDK import check FAILED");
  process.exit(1);
}
console.log(`\nAll ${specifiers.size} openclaw subpaths resolve; entry points load.`);
