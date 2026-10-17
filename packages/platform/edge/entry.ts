/**
 * Entry of the Edge Function bundle (supabase/functions/_vendor/xos-platform.js). The Supabase Edge
 * runtime can only load files inside supabase/functions, so the workspace code the functions use is
 * bundled here, with every npm package left external and mapped to an npm: specifier in deno.json.
 * The plan registry is embedded from packages/schemas/plans.yaml, its single source. The structured
 * logger with personal data redaction comes from infra/observability, so every function logs through
 * the same redactor as Atlas and the API (A22-013). Requests are observed (`observe`) and errors go
 * to Sentry through the dependency-free envelope sink when the function has a `SENTRY_DSN` secret
 * (ADR 0025).
 */
import plansYaml from "@xos/schemas/plans.yaml?raw";
import { parsePlanRegistry, type PlanRegistry } from "@xos/schemas/plans";

export * from "../src/index.ts";
export { createTransport, readEmailEnv } from "@xos/email";
export { createLogger, identityFromEnv } from "../../../infra/observability/src/logger.ts";
export { createObservability, observe } from "../../../infra/observability/src/index.ts";
export { observeEdgeFunction } from "../../../infra/observability/src/edge.ts";
export * from "./reports.ts";

/** The plan registry the bundle was built from. */
export const planRegistry: PlanRegistry = parsePlanRegistry(plansYaml);
