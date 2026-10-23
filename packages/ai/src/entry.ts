/**
 * What every Aurora entry point needs besides the client (A95, finding A65-020): whether a feature
 * can run for the person now, and what kind of problem a failed call was, so each surface shows the
 * same plain message for a refusal, a timeout or a used-up allowance. No UI and no framework, so the
 * Atlas entry points and Compass share it.
 */
import { TIMEOUT_RULE, type AuroraProblem, type AuroraStatusResult } from "./client.ts";
import type { AiFeature } from "./model.ts";

/** Whether one feature can run for the person now, or why not. */
export type FeatureAvailability =
  | { readonly kind: "ready"; readonly used: number; readonly allowance: number | null }
  | { readonly kind: "not-in-plan" }
  | { readonly kind: "off" }
  | { readonly kind: "limit-reached"; readonly allowance: number };

export function featureAvailability(
  status: AuroraStatusResult,
  feature: AiFeature,
): FeatureAvailability {
  if (!status.plan_includes_aurora) return { kind: "not-in-plan" };
  if (!status.enabled_features.includes(feature)) return { kind: "off" };
  if (status.allowance !== null && status.used >= status.allowance) {
    return { kind: "limit-reached", allowance: status.allowance };
  }
  return { kind: "ready", used: status.used, allowance: status.allowance };
}

/**
 * The kinds of failed call an entry point tells apart:
 *
 * - `timeout`: no answer in time. Nothing was written; the request may still be metered.
 * - `quota`: the org has used this month's allowance (plan_limit_exceeded, ADR 0020).
 * - `not-in-plan`, `off`: the plan lacks Aurora, or an Admin turned the feature off since the page
 *   loaded.
 * - `not-configured`: the deployment has no model provider.
 * - `offline`: the request did not reach the API.
 * - `forbidden`: the person may not do this.
 * - `refused`: the API refused with a rule, named in the detail.
 * - `unexpected`: anything else.
 */
export type AuroraProblemKind =
  | "timeout"
  | "quota"
  | "not-in-plan"
  | "off"
  | "not-configured"
  | "offline"
  | "forbidden"
  | "refused"
  | "unexpected";

export function problemKind(problem: AuroraProblem): AuroraProblemKind {
  if (problem.rule === TIMEOUT_RULE) return "timeout";
  if (problem.status === 0) return "offline";
  switch (problem.rule) {
    case "plan_limit_exceeded":
      return "quota";
    case "aurora_not_in_plan":
      return "not-in-plan";
    case "aurora_feature_off":
      return "off";
    case "aurora_not_configured":
      return "not-configured";
    default:
      break;
  }
  if (problem.status === 401 || problem.status === 403) return "forbidden";
  if (problem.status === 409 || problem.status === 422) return "refused";
  return "unexpected";
}

/** How long each entry point waits for the model, in milliseconds. Extraction reads whole files. */
export const ENTRY_TIMEOUT_MS: Readonly<Record<AiFeature, number>> = {
  assistant: 60_000,
  plain_language: 30_000,
  extraction: 90_000,
  drafting: 60_000,
  summaries: 60_000,
  mapping: 30_000,
};
