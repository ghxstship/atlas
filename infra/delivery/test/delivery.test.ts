import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RolloutInputError,
  bucketSql,
  cohortSizeSql,
  completeRolloutSql,
  decideStage,
  inRollout,
  killSwitchSql,
  rollbackRolloutSql,
  rolloutBucket,
  rolloutReason,
  stageRolloutSql,
  validatePolicy,
  type GatePolicy,
} from "../src/index.ts";

const policy = JSON.parse(
  readFileSync(fileURLToPath(new URL("../rollout.json", import.meta.url)), "utf8"),
) as GatePolicy;

describe("rollout buckets", () => {
  // Computed in Postgres 17 with bucketSql on the shared stack, so TS and SQL agree.
  it.each([
    ["imports.ai_mapping", "01928f6e-8a1b-7c2d-9e3f-4a5b6c7d8e9f", 1324],
    ["webhooks.delivery", "00000000-0000-4000-8000-000000000001", 6024],
  ])("bucket of %s for %s is %i, as in SQL", async (flag, org, expected) => {
    expect(await rolloutBucket(flag, org)).toBe(expected);
    expect(await rolloutBucket(flag, org.toUpperCase())).toBe(expected);
  });

  it("puts an org in growing cohorts only", async () => {
    const org = "01928f6e-8a1b-7c2d-9e3f-4a5b6c7d8e9f";
    expect(await inRollout("imports.ai_mapping", org, 5)).toBe(false);
    expect(await inRollout("imports.ai_mapping", org, 13.25)).toBe(true);
    expect(await inRollout("imports.ai_mapping", org, 25)).toBe(true);
  });

  it("spreads orgs roughly evenly", async () => {
    let inFive = 0;
    for (let i = 0; i < 2000; i += 1) {
      if (await inRollout("x.flag", `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`, 5))
        inFive += 1;
    }
    expect(inFive).toBeGreaterThan(60);
    expect(inFive).toBeLessThan(140);
  });

  it("writes the SQL bucket expression", () => {
    expect(bucketSql("'f'", "o.id")).toBe(
      "(('x' || substr(encode(sha256(convert_to('f' || ':' || o.id::text, 'UTF8')), 'hex'), 1, 8))::bit(32)::bigint % 10000)",
    );
  });
});

describe("flag rollout SQL on A18 flags", () => {
  it("stages a cohort without touching orgs that have an override", () => {
    const sql = stageRolloutSql("imports.ai_mapping", 25);
    expect(sql).toContain(
      "insert into app.feature_flag_overrides (org_id, flag_key, enabled, reason)",
    );
    expect(sql).toContain("'rollout:imports.ai_mapping:25'");
    expect(sql).toContain("< 2500");
    expect(sql).toContain("and not exists (");
    expect(sql).toContain("where o.deleted_at is null");
    expect(rolloutReason("a.b", 5)).toBe("rollout:a.b:5");
  });

  it("rolls back and completes only rollout overrides", () => {
    expect(rollbackRolloutSql("imports.ai_mapping")).toContain(
      "reason like 'rollout:imports.ai\\_mapping:%'",
    );
    const complete = completeRolloutSql("custom_objects.enabled");
    expect(complete).toContain(
      "update private.feature_flags set default_enabled = true where flag_key = 'custom_objects.enabled';",
    );
    expect(complete).toContain("reason like 'rollout:custom\\_objects.enabled:%'");
  });

  it("sets and releases the kill switch and counts cohorts", () => {
    expect(killSwitchSql("webhooks.delivery", true)).toContain("set kill_switch = true");
    expect(killSwitchSql("webhooks.delivery", false)).toContain("set kill_switch = false");
    const cohorts = cohortSizeSql("webhooks.delivery", [5, 25]);
    expect(cohorts).toContain('< 500) as "5_percent"');
    expect(cohorts).toContain('< 2500) as "25_percent"');
  });

  it.each([
    () => stageRolloutSql("Bad Key'; drop table x; --", 5),
    () => stageRolloutSql("ok.key", 0),
    () => stageRolloutSql("ok.key", 100),
    () => stageRolloutSql("ok.key", 5.555),
    () => stageRolloutSql("ok.key", Number.NaN),
    () => killSwitchSql("", true),
  ])("refuses unsafe input %#", (fn) => {
    expect(fn).toThrow(RolloutInputError);
  });
});

describe("release gate", () => {
  const healthy = { requests: 10_000, errors: 10, p95Ms: 200 };

  it("promotes 5 to 25 to 100 after each bake", () => {
    expect(
      decideStage(policy, {
        currentPercent: 5,
        minutesAtStage: 30,
        baseline: healthy,
        canary: { requests: 500, errors: 0, p95Ms: 210 },
      }),
    ).toEqual({
      action: "promote",
      nextPercent: 25,
      reasons: ["no regression over 30 minutes at 5 percent"],
    });
    expect(
      decideStage(policy, {
        currentPercent: 25,
        minutesAtStage: 61,
        baseline: healthy,
        canary: healthy,
      }).nextPercent,
    ).toBe(100);
    expect(
      decideStage(policy, {
        currentPercent: 100,
        minutesAtStage: 5,
        baseline: healthy,
        canary: healthy,
      }),
    ).toMatchObject({ action: "hold", nextPercent: 100 });
  });

  it("holds until there is enough traffic and bake time", () => {
    expect(
      decideStage(policy, {
        currentPercent: 5,
        minutesAtStage: 90,
        baseline: healthy,
        canary: { requests: 50, errors: 5, p95Ms: 9000 },
      }),
    ).toMatchObject({
      action: "hold",
      reasons: ["canary served 50 of the 200 requests needed to judge"],
    });
    expect(
      decideStage(policy, {
        currentPercent: 5,
        minutesAtStage: 10,
        baseline: healthy,
        canary: healthy,
      }),
    ).toMatchObject({
      action: "hold",
      reasons: ["stage has baked 10 of 30 minutes"],
    });
  });

  it("rolls back on an error ceiling, an error regression or a latency regression", () => {
    const ceiling = decideStage(policy, {
      currentPercent: 5,
      minutesAtStage: 1,
      baseline: { requests: 1000, errors: 25, p95Ms: 200 },
      canary: { requests: 1000, errors: 30, p95Ms: 200 },
    });
    expect(ceiling).toEqual({
      action: "rollback",
      nextPercent: 0,
      reasons: ["canary error rate 3.00% is above the 2.00% ceiling"],
    });
    const regression = decideStage(policy, {
      currentPercent: 25,
      minutesAtStage: 1,
      baseline: healthy,
      canary: { requests: 1000, errors: 8, p95Ms: 200 },
    });
    expect(regression.reasons).toEqual(["canary error rate 0.80% regressed from baseline 0.10%"]);
    const latency = decideStage(policy, {
      currentPercent: 5,
      minutesAtStage: 1,
      baseline: healthy,
      canary: { requests: 1000, errors: 0, p95Ms: 1200 },
    });
    expect(latency.reasons).toEqual(["canary p95 1200 ms regressed from baseline 200 ms"]);
    const fastEnough = decideStage(policy, {
      currentPercent: 5,
      minutesAtStage: 40,
      baseline: { requests: 1000, errors: 0, p95Ms: 100 },
      canary: { requests: 1000, errors: 0, p95Ms: 700 },
    });
    expect(fastEnough.action).toBe("promote");
    const unknownLatency = decideStage(policy, {
      currentPercent: 5,
      minutesAtStage: 40,
      baseline: { requests: 0, errors: 0, p95Ms: null },
      canary: { requests: 1000, errors: 0, p95Ms: 5000 },
    });
    expect(unknownLatency.action).toBe("promote");
  });

  it("validates the policy", () => {
    expect(() => validatePolicy(policy)).not.toThrow();
    expect(() => validatePolicy({ ...policy, stages: [{ percent: 5, bakeMinutes: 1 }] })).toThrow(
      "last rollout stage",
    );
    expect(() => validatePolicy({ ...policy, stages: [] })).toThrow("last rollout stage");
    expect(() =>
      validatePolicy({
        ...policy,
        stages: [
          { percent: 50, bakeMinutes: 1 },
          { percent: 25, bakeMinutes: 1 },
          { percent: 100 },
        ],
      }),
    ).toThrow("increase");
    expect(() => validatePolicy({ ...policy, stages: [{ percent: 5 }, { percent: 100 }] })).toThrow(
      "bake time",
    );
    expect(() =>
      decideStage(policy, {
        currentPercent: 50,
        minutesAtStage: 1,
        baseline: healthy,
        canary: healthy,
      }),
    ).toThrow("not a stage");
  });
});
