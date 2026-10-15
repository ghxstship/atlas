/**
 * Safety operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Safety resources here. See "Adding operations" in
 * packages/api/README.md. The module is shared: A14 owns the incident corrections
 * (parts/safety-incidents.ts) and A09 the permit and inspection ones.
 */
import { defineAdditions } from "../additions.ts";
import { incidentCorrections } from "./parts/safety-incidents.ts";

export const additions = defineAdditions("Safety", {
  corrections: [...incidentCorrections],
});
