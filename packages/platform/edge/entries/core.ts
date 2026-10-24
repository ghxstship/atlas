/**
 * The shared core every Edge Function loads through supabase/functions/_shared: the structured logger
 * with personal data redaction and the request observer from infra/observability (A22-013, ADR 0025),
 * the generic 500 problem, and the database seam over plain fetch. It imports no npm package.
 */
export { createLogger, identityFromEnv } from "../../../../infra/observability/src/logger.ts";
export { createObservability, observe } from "../../../../infra/observability/src/index.ts";
export { observeEdgeFunction } from "../../../../infra/observability/src/edge.ts";
export { edgeFunctionName, internalErrorResponse, requestIdFor } from "../../src/http/failure.ts";
export { PlatformDbError, restDb, type PlatformDb } from "../../src/stores.ts";
