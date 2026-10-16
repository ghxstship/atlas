/**
 * Release gate for progressive deployments (Section 5.1: 5, then 25, then 100 percent, with
 * automatic rollback on error-rate regression).
 *
 * `decideStage` compares the canary deployment with the current production deployment over the
 * same window and returns promote, hold or rollback with reasons. It is pure, so the same rules run
 * in CI against Vercel's metrics, in the runbook by hand, and in the tests.
 */

export interface TrafficSample {
  /** Requests served in the window. */
  readonly requests: number;
  /** Responses with status 500 or above, plus unhandled errors. */
  readonly errors: number;
  /** p95 latency in milliseconds, or null when unknown. */
  readonly p95Ms: number | null;
}

export interface RolloutStage {
  readonly percent: number;
  /** Minutes the stage must run without regression before promotion. Absent on the last stage. */
  readonly bakeMinutes?: number;
}

export interface GatePolicy {
  readonly stages: readonly RolloutStage[];
  /** Requests the canary must serve before a decision other than hold. */
  readonly minCanaryRequests: number;
  /** Absolute canary error rate that always rolls back (fraction). */
  readonly maxErrorRate: number;
  /** Error rate increase over baseline that rolls back (fraction, absolute). */
  readonly maxErrorRateIncrease: number;
  /** Canary over baseline error-rate ratio that rolls back, together with the increase above. */
  readonly maxErrorRateRatio: number;
  /** Canary over baseline p95 ratio that rolls back. */
  readonly maxLatencyRatio: number;
  /** p95 below this never counts as a regression (Section 5.1 p99 target). */
  readonly latencyFloorMs: number;
}

export type GateAction = "promote" | "hold" | "rollback";

export interface GateDecision {
  readonly action: GateAction;
  /** Next traffic percentage when promoting; the current one when holding; 0 when rolling back. */
  readonly nextPercent: number;
  readonly reasons: readonly string[];
}

export interface GateInput {
  readonly currentPercent: number;
  readonly minutesAtStage: number;
  readonly baseline: TrafficSample;
  readonly canary: TrafficSample;
}

const rate = (s: TrafficSample) => (s.requests === 0 ? 0 : s.errors / s.requests);
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

export function validatePolicy(policy: GatePolicy): void {
  const percents = policy.stages.map((s) => s.percent);
  if (percents.length === 0 || percents.at(-1) !== 100)
    throw new Error("The last rollout stage must be 100 percent.");
  for (let i = 1; i < percents.length; i += 1) {
    if ((percents[i] ?? 0) <= (percents[i - 1] ?? 0))
      throw new Error("Rollout stages must increase.");
  }
  if (policy.stages.slice(0, -1).some((s) => s.bakeMinutes === undefined || s.bakeMinutes <= 0)) {
    throw new Error("Every stage before 100 percent needs a positive bake time.");
  }
}

export function decideStage(policy: GatePolicy, input: GateInput): GateDecision {
  validatePolicy(policy);
  const index = policy.stages.findIndex((s) => s.percent === input.currentPercent);
  if (index === -1)
    throw new Error(`${input.currentPercent} percent is not a stage of this policy.`);
  const stage = policy.stages[index] as RolloutStage;
  const next = policy.stages[index + 1];

  const canaryRate = rate(input.canary);
  const baselineRate = rate(input.baseline);
  const reasons: string[] = [];

  if (input.canary.requests >= policy.minCanaryRequests) {
    if (canaryRate > policy.maxErrorRate) {
      reasons.push(
        `canary error rate ${pct(canaryRate)} is above the ${pct(policy.maxErrorRate)} ceiling`,
      );
    }
    if (
      canaryRate - baselineRate > policy.maxErrorRateIncrease &&
      canaryRate > baselineRate * policy.maxErrorRateRatio
    ) {
      reasons.push(
        `canary error rate ${pct(canaryRate)} regressed from baseline ${pct(baselineRate)}`,
      );
    }
    const cp = input.canary.p95Ms;
    const bp = input.baseline.p95Ms;
    if (
      cp !== null &&
      bp !== null &&
      cp > policy.latencyFloorMs &&
      cp > bp * policy.maxLatencyRatio
    ) {
      reasons.push(`canary p95 ${cp} ms regressed from baseline ${bp} ms`);
    }
  }
  if (reasons.length > 0) return { action: "rollback", nextPercent: 0, reasons };

  if (!next)
    return { action: "hold", nextPercent: stage.percent, reasons: ["already at 100 percent"] };
  if (input.canary.requests < policy.minCanaryRequests) {
    return {
      action: "hold",
      nextPercent: stage.percent,
      reasons: [
        `canary served ${input.canary.requests} of the ${policy.minCanaryRequests} requests needed to judge`,
      ],
    };
  }
  const bake = stage.bakeMinutes ?? 0;
  if (input.minutesAtStage < bake) {
    return {
      action: "hold",
      nextPercent: stage.percent,
      reasons: [`stage has baked ${input.minutesAtStage} of ${bake} minutes`],
    };
  }
  return {
    action: "promote",
    nextPercent: next.percent,
    reasons: [`no regression over ${input.minutesAtStage} minutes at ${stage.percent} percent`],
  };
}
