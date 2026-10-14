/**
 * Projects operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Projects resources here. See "Adding operations" in
 * packages/api/README.md.
 */
import { defineAdditions } from "../additions.ts";

export const additions = defineAdditions("Projects");
