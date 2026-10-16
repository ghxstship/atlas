import type { ProviderCode, SyncScope } from "./catalog.ts";
import type { HttpClient } from "./http.ts";
import type { Connection, IntegrationStore, ItemRef, SyncCounts, SyncRun } from "./store.ts";
import type { Credential } from "./support.ts";

/** Everything one attempt of a sync run gets. Domain reads and writes come from the connector's own ports. */
export interface SyncContext {
  readonly run: SyncRun;
  readonly connection: Connection;
  /** Null for connectors that need no credential (ticketing CSV). */
  readonly credential: Credential | null;
  readonly http: HttpClient;
  readonly store: IntegrationStore;
  /** Where the previous successful run of this scope stopped. */
  readonly cursor: string | null;
  readonly now: () => Date;
}

export interface SyncOutcome {
  readonly counts: SyncCounts;
  readonly cursorAfter: string | null;
}

/** One connector: the provider it serves and the scopes it runs. */
export interface Connector {
  readonly provider: ProviderCode;
  readonly scopes: readonly SyncScope[];
  sync(context: SyncContext): Promise<SyncOutcome>;
}

/**
 * Counts items as a connector works and records each item failure on the run, so one bad row never
 * hides the rest and none is silently dropped.
 */
export class ItemTally {
  read = 0;
  written = 0;
  skipped = 0;
  failed = 0;

  constructor(private readonly context: SyncContext) {}

  async fail(code: string, message: string, ref?: ItemRef): Promise<void> {
    this.failed += 1;
    await this.context.store.recordItemError(this.context.run.id, code, message, ref);
  }

  counts(): SyncCounts {
    return { read: this.read, written: this.written, skipped: this.skipped, failed: this.failed };
  }
}

export function connectorRegistry(
  connectors: readonly Connector[],
): ReadonlyMap<string, Connector> {
  const map = new Map<string, Connector>();
  for (const connector of connectors) {
    if (map.has(connector.provider))
      throw new Error(`Two connectors registered for ${connector.provider}.`);
    map.set(connector.provider, connector);
  }
  return map;
}
