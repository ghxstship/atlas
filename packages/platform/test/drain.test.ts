import { describe, expect, it } from "vitest";
import { drain } from "../src/notifications/drain";

describe("drain", () => {
  it("sends batch after batch until one comes back empty, adding up the counts", async () => {
    // A batch the claim partly suppressed (no device) comes back short with more still waiting.
    const queue = [50, 30, 20];
    const limits: number[] = [];
    const summary = await drain(
      async (limit) => {
        limits.push(limit);
        const attempted = queue.shift() ?? 0;
        return { attempted, sent: attempted, failed: 0 };
      },
      { batch: 50, budgetMs: 20_000, maxBatches: 10 },
    );
    expect(limits).toEqual([50, 50, 50, 50]);
    expect(summary).toEqual({ attempted: 100, sent: 100, failed: 0, batches: 4 });
  });

  it("asks once when nothing is waiting", async () => {
    const summary = await drain(async () => ({ attempted: 0 }), {
      batch: 100,
      budgetMs: 20_000,
      maxBatches: 6,
    });
    expect(summary).toEqual({ attempted: 0, batches: 1 });
  });

  it("stops at the batch count", async () => {
    const summary = await drain(async (limit) => ({ attempted: limit }), {
      batch: 100,
      budgetMs: 20_000,
      maxBatches: 4,
    });
    expect(summary).toEqual({ attempted: 400, batches: 4 });
  });

  it("starts no batch once the channel's time is spent", async () => {
    let clock = 0;
    const summary = await drain(
      async (limit) => {
        clock += 8_000;
        return { attempted: limit };
      },
      { batch: 50, budgetMs: 15_000, maxBatches: 10, now: () => clock },
    );
    expect(summary.batches).toBe(2);
  });
});
