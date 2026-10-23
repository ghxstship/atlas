import type { ChatRequestDeps } from "./connectors/communication/index.ts";
import { supabaseJobQueue } from "./framework/runner.ts";
import {
  runInboundEvents,
  supabaseInboundEventStore,
  type InboundOutcome,
} from "./inbound/worker.ts";
import { warehouseProviders } from "./warehouse/provider.ts";
import { s3Provider } from "./warehouse/s3.ts";
import {
  publicHostHttp,
  runWarehouseDeliveries,
  supabaseWarehouseStore,
  type DeliveryOutcome,
} from "./warehouse/worker.ts";
import { runIntegrationWorker, type WorkerDeps } from "./worker.ts";
import type { JobOutcome } from "./framework/runner.ts";

/**
 * One pass of the integration runtime (the integration-worker Edge Function, called every minute by pg_cron with
 * the service key; A83, finding A65-013): connector sync runs (integration.sync), inbound webhooks
 * (integration.inbound) and warehouse deliveries (warehouse.deliver). Each part runs on its own, so a failure in
 * one is reported and the others still run; every job left unfinished comes back on the next pass.
 */

export interface RuntimeDeps extends WorkerDeps {
  /** Chat lookups and a client acting as a linked person, for Slack unfurls. */
  readonly chat: ChatRequestDeps;
  /** Origin of Atlas, whose record links are unfurled. */
  readonly atlasOrigin: string;
}

export interface RuntimeSummary {
  readonly sync: readonly JobOutcome[];
  readonly inbound: readonly InboundOutcome[];
  readonly warehouse: { readonly queued: number; readonly outcomes: readonly DeliveryOutcome[] };
  /** Parts that could not run this pass, with the error; the next pass tries again. */
  readonly errors: readonly { readonly part: string; readonly message: string }[];
}

export async function runIntegrationRuntime(
  deps: RuntimeDeps,
  worker: string,
): Promise<RuntimeSummary> {
  const errors: { part: string; message: string }[] = [];
  const attempt = async <T>(part: string, run: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      errors.push({ part, message: error instanceof Error ? error.message : String(error) });
      return empty;
    }
  };
  const queue = supabaseJobQueue(deps.db);
  const sync = await attempt(
    "sync",
    () => runIntegrationWorker(deps, worker),
    [] as readonly JobOutcome[],
  );
  const inbound = await attempt(
    "inbound",
    () =>
      runInboundEvents({
        queue,
        events: supabaseInboundEventStore(deps.db),
        chat: deps.chat,
        http: deps.http,
        atlasOrigin: deps.atlasOrigin,
        worker,
      }),
    [] as readonly InboundOutcome[],
  );
  const warehouse = await attempt(
    "warehouse",
    () =>
      runWarehouseDeliveries({
        queue,
        store: supabaseWarehouseStore(deps.db),
        providers: warehouseProviders([s3Provider(publicHostHttp(deps.http, deps.resolve))]),
        worker,
      }),
    { queued: 0, outcomes: [] as readonly DeliveryOutcome[] },
  );
  return { sync, inbound, warehouse, errors };
}
