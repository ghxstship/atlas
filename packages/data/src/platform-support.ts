import type { XosClient } from "./client.ts";
import { ok, type Result } from "./result.ts";
import { rows, rpc, str, strOrNull } from "./platform-common.ts";
import { untyped } from "./untyped.ts";
import type { Database } from "./database.types.ts";

/**
 * The org's side of platform support and moderation (A90, migrations 1472 and 1473; Section 8, Digital Services
 * Act article 20). The Owner grants the platform team a support session of 1 to 24 hours and sees who on the
 * platform team opened what; members who manage listings read the moderation decisions on them, with the
 * statement of reasons, and appeal within six months. Every call runs as the signed-in member, so row level
 * security and the RPCs decide.
 */

export interface PlatformSupportSession {
  readonly id: string;
  readonly reason: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly endedAt: string | null;
  readonly open: boolean;
}

export async function listPlatformSupportSessions(
  db: XosClient,
  orgId: string,
  now: Date = new Date(),
): Promise<Result<PlatformSupportSession[]>> {
  const result = await rows(
    untyped(db)
      .from("support_sessions")
      .select("id, reason, starts_at, ends_at, ended_at")
      .eq("org_id", orgId)
      .eq("grantee", "Platform")
      .is("deleted_at", null)
      .order("starts_at", { ascending: false })
      .limit(20),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => {
      const endedAt = strOrNull(r["ended_at"]);
      const endsAt = str(r["ends_at"]);
      return {
        id: str(r["id"]),
        reason: str(r["reason"]),
        startsAt: str(r["starts_at"]),
        endsAt,
        endedAt,
        open: endedAt === null && new Date(endsAt).getTime() > now.getTime(),
      };
    }),
  );
}

/** The Owner lets the platform team read the org through the operator console for 1 to 24 hours. */
export function grantPlatformSupportSession(
  db: XosClient,
  input: { readonly orgId: string; readonly hours: number; readonly reason: string },
): Promise<Result<string>> {
  return rpc(
    db,
    "grant_platform_support_session",
    { p_org_id: input.orgId, p_hours: input.hours, p_reason: input.reason.trim() },
    str,
  );
}

export type SupportAccessArea = Database["app"]["Enums"]["support_access_area"];

export interface SupportAccess {
  readonly id: string;
  readonly sessionId: string;
  /** The operator's name; null when the person gave none. */
  readonly operatorName: string | null;
  readonly area: SupportAccessArea;
  readonly accessedAt: string;
}

/** Who on the platform team opened what, newest first (the Owner and audit readers). */
export async function listSupportAccessLog(
  db: XosClient,
  orgId: string,
): Promise<Result<SupportAccess[]>> {
  return rpc(db, "support_session_access_log", { p_org_id: orgId }, (data) =>
    ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      id: str(r["id"]),
      sessionId: str(r["support_session_id"]),
      operatorName: strOrNull(r["operator_name"]),
      area: str(r["area"]) as SupportAccessArea,
      accessedAt: str(r["accessed_at"]),
    })),
  );
}

// Moderation decisions on the org's listings ------------------------------------------------------------------------

export type ModerationDecisionAction = Database["app"]["Enums"]["moderation_action_kind"];

export interface ModerationDecision {
  readonly id: string;
  readonly opportunityId: string;
  readonly opportunityTitle: string | null;
  readonly action: ModerationDecisionAction;
  readonly ground: string | null;
  readonly ruleReference: string | null;
  readonly facts: string | null;
  readonly statement: string;
  readonly decidedAt: string;
  readonly appeal: {
    readonly id: string;
    readonly state: Database["app"]["Enums"]["moderation_appeal_state"];
    readonly filedAt: string;
    readonly decisionStatement: string | null;
  } | null;
}

/** Six months after a decision: the last day to appeal it (Digital Services Act article 20). */
export function appealDeadline(decidedAt: string): Date {
  const deadline = new Date(decidedAt);
  deadline.setUTCMonth(deadline.getUTCMonth() + 6);
  return deadline;
}

/** Whether a decision can still be appealed by the affected party. */
export function canAppeal(decision: ModerationDecision, now: Date = new Date()): boolean {
  return (
    (decision.action === "Removed" || decision.action === "Restricted") &&
    decision.appeal === null &&
    appealDeadline(decision.decidedAt).getTime() > now.getTime()
  );
}

export async function listModerationDecisions(
  db: XosClient,
  orgId: string,
): Promise<Result<ModerationDecision[]>> {
  const result = await rows(
    untyped(db)
      .from("moderation_actions")
      .select(
        "id, opportunity_id, action, ground, rule_reference, facts, statement_of_reasons, decided_at, opportunity:opportunities(title), appeals:moderation_appeals!moderation_appeals_moderation_action_id_fkey(id, appeal_state, filed_at, decision_statement, deleted_at)",
      )
      .eq("org_id", orgId)
      .order("decided_at", { ascending: false })
      .limit(50),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => {
      const opportunity = r["opportunity"] as { title?: unknown } | null;
      const appeals = (Array.isArray(r["appeals"]) ? r["appeals"] : []) as Record<
        string,
        unknown
      >[];
      const appeal = appeals.find((a) => a["deleted_at"] === null || a["deleted_at"] === undefined);
      return {
        id: str(r["id"]),
        opportunityId: str(r["opportunity_id"]),
        opportunityTitle: opportunity ? strOrNull(opportunity.title) : null,
        action: str(r["action"]) as ModerationDecisionAction,
        ground: strOrNull(r["ground"]),
        ruleReference: strOrNull(r["rule_reference"]),
        facts: strOrNull(r["facts"]),
        statement: str(r["statement_of_reasons"]),
        decidedAt: str(r["decided_at"]),
        appeal: appeal
          ? {
              id: str(appeal["id"]),
              state: str(
                appeal["appeal_state"],
              ) as Database["app"]["Enums"]["moderation_appeal_state"],
              filedAt: str(appeal["filed_at"]),
              decisionStatement: strOrNull(appeal["decision_statement"]),
            }
          : null,
      };
    }),
  );
}

/** Appeals a moderation decision with the reasons it is wrong; once per decision, within six months. */
export function fileModerationAppeal(
  db: XosClient,
  input: { readonly decisionId: string; readonly grounds: string },
): Promise<Result<string>> {
  return rpc(
    db,
    "file_moderation_appeal",
    { p_moderation_action_id: input.decisionId, p_grounds: input.grounds.trim() },
    str,
  );
}

/** Whether any decision in the list is still open to appeal. */
export function hasAppealable(
  decisions: readonly ModerationDecision[],
  now: Date = new Date(),
): boolean {
  return decisions.some((d) => canAppeal(d, now));
}
