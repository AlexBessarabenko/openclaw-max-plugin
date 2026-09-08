import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
export function resolveMaxPollingStatePath(accountId) {
    const safeId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(resolveStateDir(), "max", `polling-${safeId}.json`);
}
export async function loadMaxPollingState(accountId) {
    try {
        const { value } = await readJsonFileWithFallback(resolveMaxPollingStatePath(accountId), {});
        return value && typeof value === "object" ? value : {};
    }
    catch {
        // No HOME / unreadable state dir: polling simply starts fresh.
        return {};
    }
}
export async function saveMaxPollingState(accountId, state) {
    await writeJsonFileAtomically(resolveMaxPollingStatePath(accountId), state);
}
//# sourceMappingURL=polling-state.js.map