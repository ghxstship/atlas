/**
 * Safety operations beyond the frozen v1 catalog (additive only, Section 10.1) and corrections to
 * frozen Safety resources (ADR 0023). Two agents share the module: the permit engine and inspections
 * (A09, ./safety/permits.ts) and incidents, dispatch, emergency codes and radio (A14). This file only
 * spreads their parts.
 */
import { defineAdditions } from "../additions.ts";
import { permitActions, permitCapabilities, permitCorrections } from "./safety/permits.ts";

export const additions = defineAdditions("Safety", {
  corrections: [...permitCorrections],
  actions: { ...permitActions },
  capabilities: { ...permitCapabilities },
});
