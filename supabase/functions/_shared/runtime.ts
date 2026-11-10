// Shared plumbing for the XOS Edge Functions (Deno). Logic lives in @xos/platform; this file only reads
// the environment, builds the service-role database seam and shapes responses. It loads only the
// vendored core (no npm package), so every function's cold start stays small (A85); a function that
// needs supabase-js (storage, for example) imports it itself.
import {
  createLogger,
  edgeFunctionName,
  identityFromEnv,
  internalErrorResponse,
  requestIdFor,
  restDb,
  type PlatformDb,
} from "../_vendor/core.js";
import { observeFunction } from "./observability.ts";
import { apiKey, apiKeys, carriesSecretKey } from "./api-keys.ts";

/** A required environment variable, or a thrown error naming it. */
export function env(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set`);
  return value;
}

const readEnv = (name: string): string | undefined => Deno.env.get(name);

/** The project's secret key (`default` in SUPABASE_SECRET_KEYS; api-keys.ts, ADR 0168). Bypasses RLS: server use only. */
export function secretKey(): string {
  return apiKey("secret", readEnv);
}

/** The project's publishable key (`default` in SUPABASE_PUBLISHABLE_KEYS), for calls made as a signed-in person. */
export function publishableKey(): string {
  return apiKey("publishable", readEnv);
}

/**
 * The service-role database seam over PostgREST, in the app schema unless another is named (api_public, for
 * example). Never exposed to callers.
 */
export function serviceDb(schema = "app"): PlatformDb {
  return restDb({ url: env("SUPABASE_URL"), serviceKey: secretKey(), schema });
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the request carries the expected bearer secret (the file handover and the inbound webhooks' secrets). */
export function hasBearer(request: Request, secret: string): boolean {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") && constantTimeEqual(header.slice(7), secret);
}

/**
 * True when pg_cron's worker schedule sent the request: it carries one of the project's secret keys (api-keys.ts).
 * Every function that uses it runs with verify_jwt = false and answers 401 at once when this is false.
 */
export function isServiceRequest(request: Request): boolean {
  return carriesSecretKey(
    { apikey: request.headers.get("apikey"), authorization: request.headers.get("Authorization") },
    apiKeys("secret", readEnv),
  );
}

/**
 * Serves a handler wrapped with `observeFunction` (ADR 0025): every request is traced and logged
 * once, and an unexpected error becomes a 500 problem carrying only a request id (A22-013), with the
 * error logged through the infra/observability redactor and sent to Sentry when `SENTRY_DSN` is
 * set, never returned. The function name comes from the first request's URL; the outer catch keeps
 * the 500 guarantee should the wrapper itself fail.
 */
export function serve(handler: (request: Request) => Promise<Response>): void {
  let observed: ((request: Request) => Promise<Response>) | undefined;
  Deno.serve(async (request) => {
    try {
      observed ??= observeFunction(edgeFunctionName(request.url), handler);
      return await observed(request);
    } catch (error) {
      const fn = edgeFunctionName(request.url);
      const logger = createLogger(identityFromEnv(`edge.${fn}`, Deno.env.toObject()));
      return internalErrorResponse(error, { requestId: requestIdFor(request), logger, fn });
    }
  });
}
