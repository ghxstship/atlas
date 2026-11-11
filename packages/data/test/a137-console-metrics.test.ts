import { describe, expect, it } from "vitest";
import { failureRate, getPlatformMetrics, parsePlatformMetrics } from "../src/console-metrics.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const ok = (data: unknown) => ({ data, error: null });

const document = {
  generated_at: "2026-10-28T12:00:00Z",
  weeks: [
    { week_start: "2026-10-19", new_orgs: 3, sign_ups: 11, aurora_requests: 40 },
    { week_start: "2026-10-26", new_orgs: 1, sign_ups: 4, aurora_requests: 9 },
  ],
  orgs: { live: 120, clients: 14, without_subscription: 2 },
  people: { with_account: 900, active_1d: 80, active_7d: 310, active_30d: 610 },
  plans: [
    { plan_code: "access", orgs: 60, trialing: 0, active: 60, past_due: 0, read_only: 0 },
    { plan_code: "pro", orgs: 30, trialing: 6, active: 22, past_due: 1, read_only: 1 },
  ],
  trials: { trialing: 6, ending_7d: 2 },
  usage: [
    {
      period_start: "2026-09-01",
      meter_code: "api_requests",
      unit: "request",
      quantity: 125000,
      orgs: 18,
    },
  ],
  aurora: {
    requests_30d: 160,
    outcomes: [
      { outcome: "Answered", requests: 150 },
      { outcome: "Failed", requests: 10 },
    ],
    features: [{ feature: "assistant", requests: 160 }],
    input_tokens_30d: 480000,
    output_tokens_30d: 96000,
  },
  jobs: [
    {
      job_kind: "report.run",
      ready: 2,
      scheduled: 1,
      running: 1,
      stalled: 0,
      failed_24h: 3,
      succeeded_24h: 120,
      oldest_ready_at: "2026-10-28T11:50:00Z",
    },
  ],
  notifications: [
    { channel: "Email", total: 500, sent: 480, pending: 5, failed: 3, bounced: 12, suppressed: 0 },
    { channel: "SMS", total: 0, sent: 0, pending: 0, failed: 0, bounced: 0, suppressed: 0 },
  ],
};

describe("operator console: platform metrics", () => {
  it("reads the document with the weeks asked for, kept within 1 to 52", async () => {
    const { db, calls } = moduleClient({
      "rpc:console_platform_metrics": [ok(document), ok(document), ok(document), ok(document)],
    });
    const result = await getPlatformMetrics(db);
    expect(result.ok && result.data.weeks[1]).toEqual({
      weekStart: "2026-10-26",
      newOrgs: 1,
      signUps: 4,
      auroraRequests: 9,
    });
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({ p_weeks: 12 });
    await getPlatformMetrics(db, { weeks: 0 });
    await getPlatformMetrics(db, { weeks: 400 });
    await getPlatformMetrics(db, { weeks: 8.7 });
    expect(calls.slice(1).map((c) => stepsOf(c, "args")[0]?.[0])).toEqual([
      { p_weeks: 1 },
      { p_weeks: 52 },
      { p_weeks: 8 },
    ]);
  });

  it("maps every figure group", () => {
    const m = parsePlatformMetrics(document);
    expect(m.orgs).toEqual({ live: 120, clients: 14, withoutSubscription: 2 });
    expect(m.people).toEqual({ withAccount: 900, active1d: 80, active7d: 310, active30d: 610 });
    expect(m.plans[1]).toEqual({
      planCode: "pro",
      orgs: 30,
      trialing: 6,
      active: 22,
      pastDue: 1,
      readOnly: 1,
    });
    expect(m.trials).toEqual({ trialing: 6, ending7d: 2 });
    expect(m.usage[0]).toMatchObject({ meterCode: "api_requests", quantity: 125000, orgs: 18 });
    expect(m.aurora).toMatchObject({
      requests30d: 160,
      inputTokens30d: 480000,
      outputTokens30d: 96000,
    });
    expect(m.aurora.outcomes).toContainEqual({ outcome: "Failed", requests: 10 });
    expect(m.jobs[0]).toMatchObject({
      jobKind: "report.run",
      failed24h: 3,
      oldestReadyAt: "2026-10-28T11:50:00Z",
    });
    expect(m.notifications[0]).toMatchObject({ channel: "Email", bounced: 12, failed: 3 });
  });

  it("reads a missing group as empty or zero", () => {
    const m = parsePlatformMetrics(null);
    expect(m.weeks).toEqual([]);
    expect(m.people.active7d).toBe(0);
    expect(m.aurora.outcomes).toEqual([]);
    expect(parsePlatformMetrics({ jobs: [{ job_kind: "x" }] }).jobs[0]?.oldestReadyAt).toBeNull();
  });

  it("passes a refusal through", async () => {
    const { db } = moduleClient({
      "rpc:console_platform_metrics": [
        {
          data: null,
          error: { code: "42501", message: "the operator console is for the platform team" },
        },
      ],
    });
    const result = await getPlatformMetrics(db);
    expect(result.ok).toBe(false);
  });

  it("rates failures over settled deliveries", () => {
    const [email, sms] = parsePlatformMetrics(document).notifications;
    expect(email && failureRate(email)).toBeCloseTo(15 / 495);
    expect(sms && failureRate(sms)).toBeNull();
  });
});
