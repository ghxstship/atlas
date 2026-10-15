/**
 * Safety handlers. Two agents share the module: the permit engine and inspections (A09,
 * ./safety/permits.ts) and incidents, dispatch, emergency codes and radio (A14). This file only
 * spreads their parts.
 */
import { defineHandlers } from "../runtime/handler.ts";
import { permitHandlers } from "./safety/permits.ts";

export const handlers = defineHandlers("Safety", { ...permitHandlers });
