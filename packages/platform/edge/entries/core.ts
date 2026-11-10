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
export type { ProjectTokenSigner } from "../../src/jwt/project-token.ts";
import type * as ProjectTokens from "../../src/jwt/project-token.ts";

/** The project token signer (ADR 0168), loaded on demand: only api-token and the workers that mint tokens need it. */
export function loadProjectTokens(): Promise<typeof ProjectTokens> {
  return import("../../src/jwt/project-token.ts");
}
