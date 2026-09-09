/**
 * Inbound message deduplication (messageId → timestamp, TTL 5 min in memory).
 *
 * Lives in its own module so the polling loop (channel.ts) can prime the
 * filter from the persisted state after a restart and snapshot it back for
 * persistence — without importing the plugin entry (which would be circular).
 *
 * The in-memory TTL covers replays within a run; restarts are covered by the
 * persisted snapshot (see src/polling-state.ts): a replayed batch right after
 * startup hits primed ids, however long the gateway was down.
 */
const seenMessages = new Map<string, number>();
export const DEDUP_TTL_MS = 5 * 60 * 1000;
/** How many recent ids are persisted alongside the polling marker. */
const PERSISTED_SEEN_LIMIT = 500;

function prune(now: number): void {
  for (const [id, ts] of seenMessages.entries()) {
    if (now - ts > DEDUP_TTL_MS) {
      seenMessages.delete(id);
    }
  }
}

export function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  prune(now);
  if (seenMessages.has(messageId)) {
    return true;
  }
  seenMessages.set(messageId, now);
  return false;
}

/** Load persisted ids (from the last run) into the filter with a fresh TTL. */
export function primeSeenMessageIds(ids: readonly string[]): void {
  const now = Date.now();
  for (const id of ids) {
    if (!seenMessages.has(id)) seenMessages.set(id, now);
  }
}

/** The most recent ids, for persisting together with the polling marker. */
export function recentSeenMessageIds(limit = PERSISTED_SEEN_LIMIT): string[] {
  prune(Date.now());
  const ids = [...seenMessages.keys()];
  return ids.slice(Math.max(0, ids.length - limit));
}

/** Test hook. */
export function clearSeenMessageIds(): void {
  seenMessages.clear();
}
