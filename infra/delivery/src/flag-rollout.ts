/**
 * Percentage rollouts on A18's feature flags (0540: private.feature_flags with plan gating and a
 * kill switch, app.feature_flag_overrides per org). There is no second flag system: a rollout
 * stage is a set of per-org overrides whose reason starts with `rollout:<flag>:`, chosen by the
 * deterministic bucket in bucket.ts. Manual overrides (any other reason) are never touched, and
 * the kill switch and plan gating still win over every override, as private.flag_enabled decides.
 *
 * The functions return SQL for an operator to run with the service role (the runbook in
 * infra/runbooks/progressive-delivery.md says when). Nothing here connects to a database.
 */

import { bucketSql } from "./bucket.ts";

const FLAG_KEY = /^[a-z][a-z0-9_.]*$/;

export class RolloutInputError extends Error {
  override name = "RolloutInputError";
}

function assertFlag(flagKey: string): void {
  if (!FLAG_KEY.test(flagKey))
    throw new RolloutInputError(`Flag key ${JSON.stringify(flagKey)} is not a valid flag key.`);
}

function assertPercent(percent: number): void {
  if (
    !Number.isFinite(percent) ||
    percent <= 0 ||
    percent >= 100 ||
    Math.round(percent * 100) !== percent * 100
  ) {
    throw new RolloutInputError(
      "A rollout stage is a percentage above 0 and below 100 with at most two decimals; use completeRolloutSql for 100.",
    );
  }
}

/** The override reason that marks a row as part of a rollout, so later stages and rollbacks find it. */
export function rolloutReason(flagKey: string, percent: number): string {
  return `rollout:${flagKey}:${percent}`;
}

/**
 * Grows the rollout to `percent`: inserts an enabling override for every live org in the cohort
 * that has no override for the flag yet. Idempotent; orgs already in an earlier stage keep theirs.
 */
export function stageRolloutSql(flagKey: string, percent: number): string {
  assertFlag(flagKey);
  assertPercent(percent);
  const flag = `'${flagKey}'`;
  return [
    `-- Roll ${flagKey} out to ${percent} percent of orgs (Section 5.1 change safety).`,
    "begin;",
    "insert into app.feature_flag_overrides (org_id, flag_key, enabled, reason)",
    `select o.id, ${flag}, true, '${rolloutReason(flagKey, percent)}'`,
    "from app.organizations o",
    "where o.deleted_at is null",
    `  and ${bucketSql(flag, "o.id")} < ${Math.round(percent * 100)}`,
    "  and not exists (",
    "    select 1 from app.feature_flag_overrides x",
    `    where x.org_id = o.id and x.flag_key = ${flag} and x.deleted_at is null`,
    "  );",
    "commit;",
    "",
  ].join("\n");
}

/** Ends the rollout early: soft deletes every rollout override, so orgs fall back to the default. */
export function rollbackRolloutSql(flagKey: string): string {
  assertFlag(flagKey);
  return [
    `-- Roll ${flagKey} back: remove rollout overrides; manual overrides stay.`,
    "begin;",
    "update app.feature_flag_overrides set deleted_at = now()",
    `where flag_key = '${flagKey}' and deleted_at is null and reason like 'rollout:${flagKey.replace(/_/g, "\\_")}:%';`,
    "commit;",
    "",
  ].join("\n");
}

/** Finishes the rollout at 100 percent: the default turns on and the rollout overrides retire. */
export function completeRolloutSql(flagKey: string): string {
  assertFlag(flagKey);
  return [
    `-- Complete ${flagKey}: on by default, rollout overrides retired; manual overrides stay.`,
    "begin;",
    `update private.feature_flags set default_enabled = true where flag_key = '${flagKey}';`,
    "update app.feature_flag_overrides set deleted_at = now()",
    `where flag_key = '${flagKey}' and deleted_at is null and reason like 'rollout:${flagKey.replace(/_/g, "\\_")}:%';`,
    "commit;",
    "",
  ].join("\n");
}

/** The kill switch: off for every org at once, whatever the overrides and plans say. */
export function killSwitchSql(flagKey: string, on: boolean): string {
  assertFlag(flagKey);
  return [
    on ? `-- Kill ${flagKey} everywhere now.` : `-- Release the kill switch on ${flagKey}.`,
    `update private.feature_flags set kill_switch = ${on} where flag_key = '${flagKey}';`,
    "",
  ].join("\n");
}

/** How many live orgs each stage would cover, to read before running a stage. */
export function cohortSizeSql(flagKey: string, percents: readonly number[]): string {
  assertFlag(flagKey);
  percents.forEach(assertPercent);
  const columns = percents
    .map(
      (p) =>
        `  count(*) filter (where ${bucketSql(`'${flagKey}'`, "o.id")} < ${Math.round(p * 100)}) as "${p}_percent"`,
    )
    .join(",\n");
  return `select\n${columns},\n  count(*) as all_orgs\nfrom app.organizations o\nwhere o.deleted_at is null;\n`;
}
