export declare function isMaxInfraHost(hostname: string): boolean;
type FetchLike = (input: any, init?: any) => Promise<any>;
type CertLogger = {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
};
/**
 * fetch wrapper that routes MAX-infrastructure hosts through the CA-enriched
 * dispatcher and everything else through the untouched global fetch. Pass it
 * to the max-bot-api client (`clientOptions.fetch`) and use it for direct
 * calls (uploads, attachment downloads, probes).
 */
export declare function createMaxScopedFetch(logger?: CertLogger): FetchLike;
export {};
//# sourceMappingURL=certs.d.ts.map