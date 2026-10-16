/**
 * Rate limits (ADR 0003): every response carries `RateLimit-Limit`, `RateLimit-Remaining` and
 * `RateLimit-Reset`; a caller over the limit gets 429 with `Retry-After`.
 *
 * The default limiter counts in Postgres (`app.take_api_rate_limit`, migration 1040), so every
 * server instance shares one fixed window per caller (A22-012). When the database cannot answer,
 * the in-process window limiter decides for that request and the failure is reported, so a database
 * outage neither blocks the API nor lifts the limit entirely. Tests use the in-process limiter.
 */
import { rateLimited } from "../problem.ts";
import type { RequestContext } from "./context.ts";

export interface RateLimitDecision {
  readonly limit: number;
  readonly remaining: number;
  /** Seconds until the window resets. */
  readonly reset: number;
  readonly allowed: boolean;
}

export interface RateLimiter {
  /** Counts one request. `context` is the authenticated caller, for limiters that query as them. */
  take(callerKey: string, context?: RequestContext): Promise<RateLimitDecision> | RateLimitDecision;
}

export interface WindowOptions {
  readonly limit?: number;
  readonly windowSeconds?: number;
  readonly now?: () => number;
  /** Windows tracked before the oldest are dropped. */
  readonly maxCallers?: number;
}

export function createWindowRateLimiter(options: WindowOptions = {}): RateLimiter {
  const limit = options.limit ?? 600;
  const windowMs = (options.windowSeconds ?? 60) * 1000;
  const now = options.now ?? Date.now;
  const maxCallers = options.maxCallers ?? 50_000;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    take(callerKey) {
      const at = now();
      let window = windows.get(callerKey);
      if (window === undefined || at - window.start >= windowMs) {
        windows.delete(callerKey);
        if (windows.size >= maxCallers) {
          const oldest = windows.keys().next().value;
          if (oldest !== undefined) windows.delete(oldest);
        }
        window = { start: at, count: 0 };
        windows.set(callerKey, window);
      }
      window.count += 1;
      const reset = Math.max(1, Math.ceil((window.start + windowMs - at) / 1000));
      return {
        limit,
        remaining: Math.max(0, limit - window.count),
        reset,
        allowed: window.count <= limit,
      };
    },
  };
}

export interface SharedOptions {
  readonly limit?: number;
  readonly windowSeconds?: number;
  /** Decides when the database cannot; defaults to an in-process window limiter with the same limit. */
  readonly fallback?: RateLimiter;
  /** Told about each database failure before the fallback decides. */
  readonly onFallback?: (error: unknown) => void;
}

interface RpcCaller {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/**
 * A limiter whose windows live in Postgres and are shared by every server instance (A22-012). The
 * RPC runs as the caller and counts against `auth.uid()`, so an API key (its own service account)
 * and a person each get one window however many instances serve them.
 */
export function createSharedRateLimiter(options: SharedOptions = {}): RateLimiter {
  const limit = options.limit ?? 600;
  const windowSeconds = options.windowSeconds ?? 60;
  const fallback = options.fallback ?? createWindowRateLimiter({ limit, windowSeconds });
  const report =
    options.onFallback ??
    ((error: unknown) =>
      console.error(
        JSON.stringify({
          level: "warn",
          source: "api.rate-limit",
          message: "shared rate limit unavailable; the in-process limiter decided",
          reason: error instanceof Error ? error.message : String(error),
        }),
      ));
  return {
    async take(callerKey, context) {
      if (context === undefined) return fallback.take(callerKey);
      try {
        const { data, error } = await (context.db as unknown as RpcCaller).rpc(
          "take_api_rate_limit",
          { p_limit: limit, p_window_seconds: windowSeconds },
        );
        if (error !== null) throw new Error(error.message);
        const row = (Array.isArray(data) ? data[0] : data) as
          { allowed?: unknown; remaining?: unknown; reset_seconds?: unknown } | undefined;
        if (
          typeof row?.allowed !== "boolean" ||
          typeof row.remaining !== "number" ||
          typeof row.reset_seconds !== "number"
        ) {
          throw new Error("take_api_rate_limit answered an unexpected shape");
        }
        return {
          limit,
          remaining: row.remaining,
          reset: row.reset_seconds,
          allowed: row.allowed,
        };
      } catch (error) {
        report(error);
        return fallback.take(callerKey, context);
      }
    },
  };
}

export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  return {
    "RateLimit-Limit": String(decision.limit),
    "RateLimit-Remaining": String(decision.remaining),
    "RateLimit-Reset": String(decision.reset),
  };
}

/** Throws the 429 problem, with `Retry-After` and the rate limit headers, when over the limit. */
export function enforce(decision: RateLimitDecision): void {
  if (decision.allowed) return;
  const problem = rateLimited(decision.reset);
  Object.assign(problem.headers, rateLimitHeaders(decision));
  throw problem;
}
