/**
 * A22-012: the rate limit holds across server instances. Two limiters stand in for two instances;
 * a scripted database stands in for Postgres and app.take_api_rate_limit (migration 1040), counting
 * per caller exactly as the RPC does.
 */
import { describe, expect, it } from "vitest";
import type { RequestContext } from "../../src/runtime/context.ts";
import { createSharedRateLimiter, createWindowRateLimiter } from "../../src/runtime/rate-limit.ts";

/** One shared database: counts per (user, window length), as the RPC upsert does. */
function scriptedDatabase() {
  const windows = new Map<string, number>();
  const calls: Record<string, unknown>[] = [];
  const dbFor = (userId: string) => ({
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, ...args });
      const key = `${userId}:${String(args["p_window_seconds"])}`;
      const count = (windows.get(key) ?? 0) + 1;
      windows.set(key, count);
      const limit = Number(args["p_limit"]);
      return {
        data: [
          { allowed: count <= limit, remaining: Math.max(0, limit - count), reset_seconds: 42 },
        ],
        error: null,
      };
    },
  });
  return { dbFor, calls };
}

function contextFor(userId: string, db: unknown): RequestContext {
  return {
    user: { id: userId, email: null },
    personId: null,
    org: null,
    locale: "en-US",
    db: db as RequestContext["db"],
    credential: "api_key",
    requestId: "req-1",
  };
}

describe("shared rate limit (A22-012, ASVS V2.4.1)", () => {
  it("counts a caller once across two server instances", async () => {
    const database = scriptedDatabase();
    const instanceA = createSharedRateLimiter({ limit: 3 });
    const instanceB = createSharedRateLimiter({ limit: 3 });
    const caller = contextFor("key-user", database.dbFor("key-user"));
    const decisions = [];
    for (let i = 0; i < 3; i += 1) {
      decisions.push(await instanceA.take("api_key:key-user", caller));
      decisions.push(await instanceB.take("api_key:key-user", caller));
    }
    expect(decisions.filter((d) => d.allowed)).toHaveLength(3);
    expect(decisions.at(-1)).toEqual({ limit: 3, remaining: 0, reset: 42, allowed: false });
    expect(database.calls[0]).toEqual({
      name: "take_api_rate_limit",
      p_limit: 3,
      p_window_seconds: 60,
    });

    // Another caller has their own window.
    const other = contextFor("person-user", database.dbFor("person-user"));
    expect((await instanceA.take("session:person-user", other)).allowed).toBe(true);
  });

  it("falls back to the in-process limiter, and reports why, when the database fails", async () => {
    const failures: unknown[] = [];
    const limiter = createSharedRateLimiter({
      limit: 1,
      fallback: createWindowRateLimiter({ limit: 1, now: () => 0 }),
      onFallback: (error) => failures.push(error),
    });
    const broken = contextFor("u", {
      rpc: async () => ({ data: null, error: { message: "connection refused" } }),
    });
    expect((await limiter.take("session:u", broken)).allowed).toBe(true);
    expect((await limiter.take("session:u", broken)).allowed).toBe(false);
    expect(failures).toHaveLength(2);
    expect(String(failures[0])).toContain("connection refused");

    const odd = contextFor("v", { rpc: async () => ({ data: [{ allowed: "yes" }], error: null }) });
    await limiter.take("session:v", odd);
    expect(String(failures[2])).toContain("unexpected shape");
  });

  it("uses the in-process limiter when no caller context is given", async () => {
    const limiter = createSharedRateLimiter({ limit: 1, onFallback: () => undefined });
    expect((await limiter.take("anonymous")).allowed).toBe(true);
    expect((await limiter.take("anonymous")).allowed).toBe(false);
  });

  it("reports a database failure to the log by default", async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: string) => lines.push(line);
    try {
      const limiter = createSharedRateLimiter({ limit: 5 });
      const thrown = contextFor("w", {
        rpc: () => {
          throw new Error("socket closed");
        },
      });
      expect((await limiter.take("session:w", thrown)).allowed).toBe(true);
    } finally {
      console.error = original;
    }
    expect(lines.join("\n")).toContain("socket closed");
  });
});
