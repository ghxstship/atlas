/**
 * The integration runtime and the import worker for the Edge bundle (A83, RRR-128; findings A65-013, A65-025 and
 * A65-029). The logic lives in @xos/integrations (connector sync runs, inbound webhooks, warehouse delivery) and
 * @xos/data (the import worker with its Google Sheets reader); this file names exactly what the
 * integration-worker, integration-inbound and import-run functions use, so no other export of those packages
 * reaches the bundle.
 */
export {
  asDbClient,
  handleInboundRequest,
  httpFromFetch,
  integrationsTranslator,
  mintChatSession,
  runIntegrationRuntime,
  supabaseCommunicationSource,
  supabaseInboundStore,
  type ChatRequestDeps,
  type DbClient,
  type InboundSecrets,
  type RuntimeDeps,
} from "../../integrations/src/index.ts";

export { runImportJobs, supabaseImportStore } from "../../data/src/import-worker.ts";
