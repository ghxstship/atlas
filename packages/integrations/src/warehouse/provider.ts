import { IntegrationError } from "../framework/errors.ts";

/**
 * The warehouse provider seam (A83, finding A65-029). A delivery writes plain files (one per table, a schema
 * and a manifest); a provider only has to put an object in the customer's bucket. S3 and every S3-compatible
 * service are built (s3.ts). Google Cloud Storage, Azure Blob, BigQuery and Snowflake are named by the spec
 * and are not built yet: each is listed here as unavailable and refuses to deliver, and migration 1401
 * (private.warehouse_providers) refuses a destination for them, so no customer can configure one. Building a
 * provider means implementing `put` (for BigQuery and Snowflake, a load job from the written files) and
 * marking it available in both places.
 */

export type WarehouseProviderName =
  "S3" | "Google Cloud Storage" | "Azure Blob" | "BigQuery" | "Snowflake";

export const WAREHOUSE_PROVIDERS: readonly WarehouseProviderName[] = [
  "S3",
  "Google Cloud Storage",
  "Azure Blob",
  "BigQuery",
  "Snowflake",
];

/** Where a delivery goes, from app.claim_warehouse_delivery. */
export interface WarehouseTarget {
  readonly provider: WarehouseProviderName;
  readonly bucket: string;
  readonly region: string | null;
  /** HTTPS endpoint of an S3-compatible service; null for AWS S3. */
  readonly endpointUrl: string | null;
}

export interface WarehouseObject {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface WarehouseProvider {
  readonly provider: WarehouseProviderName;
  readonly available: boolean;
  /** Writes one object; throws an IntegrationError (retryable or not) when the bucket refuses. */
  put(target: WarehouseTarget, secret: string, object: WarehouseObject): Promise<void>;
}

/** A provider that is named but not built: it refuses every delivery with a permanent failure. */
export function unavailableProvider(provider: WarehouseProviderName): WarehouseProvider {
  return {
    provider,
    available: false,
    put() {
      return Promise.reject(
        new IntegrationError(
          "warehouse_provider_unavailable",
          `Delivery to ${provider} is not available yet. Use S3 or an S3-compatible bucket.`,
        ),
      );
    },
  };
}

/** Every provider by name: the given built ones, and the rest as unavailable. */
export function warehouseProviders(
  built: readonly WarehouseProvider[],
): ReadonlyMap<WarehouseProviderName, WarehouseProvider> {
  const map = new Map<WarehouseProviderName, WarehouseProvider>();
  for (const name of WAREHOUSE_PROVIDERS) {
    map.set(name, built.find((p) => p.provider === name) ?? unavailableProvider(name));
  }
  return map;
}
