import type { HostResolver } from "@xos/platform/webhooks";
import { PROVIDERS } from "./framework/catalog.ts";
import { connectorRegistry, type Connector } from "./framework/connector.ts";
import type { DbClient } from "./framework/db.ts";
import type { HttpClient } from "./framework/http.ts";
import type { Translate } from "./framework/messages.ts";
import { runIntegrationJobs, supabaseJobQueue, type JobOutcome } from "./framework/runner.ts";
import { supabaseIntegrationStore } from "./framework/store.ts";
import { accountingConnectors, supabaseAccountingSource } from "./connectors/accounting/index.ts";
import { calendarConnectors, supabaseCalendarSource } from "./connectors/calendar/index.ts";
import { chatConnectors, supabaseCommunicationSource } from "./connectors/communication/index.ts";
import { payrollConnectors, supabasePayrollSource } from "./connectors/payroll/index.ts";
import { supabaseTrackingSource, trackingConnectors } from "./connectors/shipping/index.ts";
import {
  storageConnectors,
  supabaseBlobStore,
  supabaseStorageSource,
} from "./connectors/storage/index.ts";
import { supabaseTicketingSource, ticketingConnectors } from "./connectors/ticketing/index.ts";

type StorageClient = Parameters<typeof supabaseBlobStore>[0] &
  Parameters<typeof supabaseTicketingSource>[1];

export interface WorkerDeps {
  /** Service-role client on schema app (the runner RPCs are service role only). */
  readonly db: DbClient;
  /** Service-role client on schema xpms, for the fixed chart. */
  readonly canon: DbClient;
  /** Supabase Storage of the service-role client. */
  readonly storage: StorageClient;
  readonly http: HttpClient;
  readonly resolve: HostResolver;
  readonly translate: Translate;
}

/** Every Section 17 connector over the Supabase sources, one per provider of the catalog. */
export function allConnectors(deps: WorkerDeps): Connector[] {
  return [
    ...accountingConnectors(supabaseAccountingSource(deps.db, deps.canon)),
    ...calendarConnectors(supabaseCalendarSource(deps.db)),
    ...storageConnectors(supabaseStorageSource(deps.db), supabaseBlobStore(deps.storage)),
    ...chatConnectors(supabaseCommunicationSource(deps.db), deps.translate),
    ...payrollConnectors(supabasePayrollSource(deps.db)),
    ...trackingConnectors(supabaseTrackingSource(deps.db)),
    ...ticketingConnectors(supabaseTicketingSource(deps.db, deps.storage), deps.resolve),
  ];
}

/** Providers of the catalog without a connector; empty when every connector is wired. */
export function unwiredProviders(connectors: readonly Connector[]): string[] {
  const wired = new Set(connectors.map((c) => c.provider));
  return PROVIDERS.map((p) => p.code).filter((code) => !wired.has(code));
}

/**
 * One pass of the integration worker (an Edge Function on a schedule): claims ready integration.sync
 * jobs from the A18 job queue and runs one attempt of each.
 */
export function runIntegrationWorker(
  deps: WorkerDeps,
  worker: string,
  limit = 10,
): Promise<readonly JobOutcome[]> {
  return runIntegrationJobs({
    queue: supabaseJobQueue(deps.db),
    store: supabaseIntegrationStore(deps.db),
    connectors: connectorRegistry(allConnectors(deps)),
    http: deps.http,
    worker,
    limit,
  });
}
