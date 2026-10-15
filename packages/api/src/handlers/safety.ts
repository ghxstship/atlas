/**
 * Safety handlers. Add one entry per operationId of the Safety module; operations left out stay
 * document-only. See "Adding handlers" in packages/api/README.md. The module is shared: A14 owns
 * the incident handlers (parts/safety-incidents.ts) and A09 the permit and inspection ones.
 */
import { defineHandlers, type HandlerSet } from "../runtime/handler.ts";
import { incidentHandlers } from "./parts/safety-incidents.ts";

export const handlers = defineHandlers("Safety", {
  ...(incidentHandlers as unknown as HandlerSet<"Safety">),
});
