export declare const DEDUP_TTL_MS: number;
export declare function isDuplicate(messageId: string): boolean;
/** Load persisted ids (from the last run) into the filter with a fresh TTL. */
export declare function primeSeenMessageIds(ids: readonly string[]): void;
/** The most recent ids, for persisting together with the polling marker. */
export declare function recentSeenMessageIds(limit?: number): string[];
/** Test hook. */
export declare function clearSeenMessageIds(): void;
//# sourceMappingURL=dedup.d.ts.map