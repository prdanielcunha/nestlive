/**
 * Public compatibility contract for NestLive domain payloads and adapters.
 *
 * Increment only for an intentional breaking change to externally persisted or
 * exchanged domain contracts. Backward-compatible additions keep the same major.
 */
export const MUSICSCALE_LIVE_DOMAIN_CONTRACT_VERSION = 1 as const;

/**
 * Adapter manifests currently implement the v1 public SDK contract.
 */
export const MUSICSCALE_LIVE_ADAPTER_SDK_VERSION = 1 as const;
