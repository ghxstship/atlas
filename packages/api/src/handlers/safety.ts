/**
 * Safety handlers. Two agents share the module: the permit engine and inspections (A09,
 * ./parts/safety-permits.ts) and incidents, dispatch, emergency codes and radio (A14,
 * ./parts/safety-incidents.ts). This file only spreads their parts.
 */
import { defineHandlers, type HandlerSet } from "../runtime/handler.ts";
import { incidentHandlers } from "./parts/safety-incidents.ts";
import { permitHandlers } from "./parts/safety-permits.ts";

export const handlers = defineHandlers("Safety", {
  ...permitHandlers,
  ...(incidentHandlers as unknown as HandlerSet<"Safety">),
});
