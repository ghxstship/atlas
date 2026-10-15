/**
 * Rate limits (ADR 0003): every response carries `RateLimit-Limit`, `RateLimit-Remaining` and
 * `RateLimit-Reset`; a caller over the limit gets 429 with `Retry-After`. The default limiter is a
 * fixed window per caller held in this process, so each server instance counts on its own.
 */
import { rateLimited } from "../problem.ts";

export interface RateLimitDecision {
  readonly limit: number;
  readonly remaining: number;
  /** Seconds until the window resets. */
  readonly reset: number;
  readonly allowed: boolean;
}

export interface RateLimiter {
  take(callerKey: string): Promise<RateLimitDecision> | RateLimitDecision;
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
