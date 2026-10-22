/**
 * integration-inbound: provider webhooks verified on their raw body, recorded for integration-worker or
 * answered at once (A83). Imported module by module from @xos/integrations.
 */
export { asDbClient } from "../../../integrations/src/framework/db.ts";
export { integrationsTranslator } from "../../../integrations/src/framework/messages.ts";
export {
  handleInboundRequest,
  supabaseInboundStore,
} from "../../../integrations/src/inbound/handler.ts";
export { mintChatSession } from "../../../integrations/src/inbound/session.ts";
export { supabaseCommunicationSource } from "../../../integrations/src/connectors/communication/index.ts";
