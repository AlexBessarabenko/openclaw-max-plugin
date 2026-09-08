import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";

/**
 * Persistent per-account polling state: the long-polling marker plus the tail
 * of the dedup list.
 *
 * The marker survives gateway restarts, so updates are neither lost nor
 * replayed past the server-side retention window. It is written ONLY after
 * the whole batch has been processed (at-least-once): a crash between batch
 * processing and persist replays at most one batch, and the persisted
 * seenMessageIds absorb the replay through the mid dedup filter.
 */
export type MaxPollingState = {
  marker?: number | null;
  seenMessageIds?: string[];
};

export function resolveMaxPollingStatePath(accountId: string): string {
  const safeId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(resolveStateDir(), "max", `polling-${safeId}.json`);
}

export async function loadMaxPollingState(accountId: string): Promise<MaxPollingState> {
  try {
    const { value } = await readJsonFileWithFallback<MaxPollingState>(
      resolveMaxPollingStatePath(accountId),
      {},
    );
    return value && typeof value === "object" ? value : {};
  } catch {
    // No HOME / unreadable state dir: polling simply starts fresh.
    return {};
  }
}

export async function saveMaxPollingState(
  accountId: string,
  state: MaxPollingState,
): Promise<void> {
  await writeJsonFileAtomically(resolveMaxPollingStatePath(accountId), state);
}
