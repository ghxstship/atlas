/**
 * Safety handlers. Two agents share the module: the permit engine and inspections (A09,
^ * ./parts/safety-permits.ts) and incidents, dispatch, emergency codes and radio (A14). This file only
 * spreads their parts.
 */
import { defineHandlers } from "../runtime/handler.ts";
import { permitHandlers } from "./parts/safety-permits.ts";

export const handlers = defineHandlers("Safety", { ...permitHandlers });
