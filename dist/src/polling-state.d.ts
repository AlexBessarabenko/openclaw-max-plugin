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
export declare function resolveMaxPollingStatePath(accountId: string): string;
export declare function loadMaxPollingState(accountId: string): Promise<MaxPollingState>;
export declare function saveMaxPollingState(accountId: string, state: MaxPollingState): Promise<void>;
//# sourceMappingURL=polling-state.d.ts.map