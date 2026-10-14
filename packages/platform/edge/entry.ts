/**
 * Entry of the Edge Function bundle (supabase/functions/_vendor/xos-platform.js). The Supabase Edge
 * runtime can only load files inside supabase/functions, so the workspace code the functions use is
 * bundled here, with every npm package left external and mapped to an npm: specifier in deno.json.
 * The plan registry is embedded from packages/schemas/plans.yaml, its single source.
 */
import plansYaml from "@xos/schemas/plans.yaml?raw";
import { parsePlanRegistry, type PlanRegistry } from "@xos/schemas/plans";

export * from "../src/index.ts";
export { createTransport, readEmailEnv } from "@xos/email";

/** The plan registry the bundle was built from. */
export const planRegistry: PlanRegistry = parsePlanRegistry(plansYaml);
