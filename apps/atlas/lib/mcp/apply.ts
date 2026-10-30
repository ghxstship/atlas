import "server-only";
import {
  OPERATIONS,
  XosApiError,
  XosClient as ApiClient,
  type OperationSpec,
} from "@ghxstship/xos-sdk";
import type { XosClient } from "@xos/data";
import { bodyFromFields, getProposalForApply } from "@xos/data/agent-proposals";
import { transitionAiSuggestion } from "@xos/data/ai";
import { CAPABILITY_CODES } from "@xos/schemas/capabilities/codes";
import { inProcessSessionFetch } from "@/lib/api/in-process";
import { env } from "@/lib/env";
import { observability } from "@/lib/observability";

/**
 * Confirming a change a connected app proposed (B16, ADR 0155 D2): one proposal at a time, with the person's own
 * session, never in bulk.
 *   1. app.agent_proposal_for_apply: the person's own Proposed, unexpired proposal of an app they still grant
 *   2. the operation is looked up in the SDK's OPERATIONS and its capability groups are checked against the live
 *      grant again, refusing a Restricted group as the database does (C23)
 *   3. Proposed to Confirmed
 *   4. the public operation runs in process as the person's session bound to the proposal's org, with the incoming
 *      request's address and trace (C28) so the org IP allow-list judges the person, Idempotency-Key the suggestion
 *      id and If-Match the etag the app read, so a stale proposal fails safely
 *   5. Confirmed to Applied with the record the API wrote (else the target, else the suggestion itself); a refusal
 *      returns it to Proposed and says why
 */

const SPECS = OPERATIONS as Readonly<Record<string, OperationSpec>>;

/** Capability groups that reach Restricted data or the org's control, as private.oauth_scope_restricted (1563). */
export const RESTRICTED_GROUPS: ReadonlySet<string> = new Set([
  "org",
  "audit",
  ...CAPABILITY_CODES.filter((c) => c.includes(".restricted")).map((c) => c.split(".")[0] ?? c),
]);

export type ApplyOutcome =
  | { readonly ok: true; readonly appliedId: string }
  | { readonly ok: false; readonly rule: string; readonly detail?: string };

/** The operation's checks before anything is written: it exists, may be proposed, and lies within the grant. */
export function operationAllowed(
  operationId: string,
  grant: readonly string[],
): OperationSpec | string {
  const spec = SPECS[operationId];
  if (!spec || spec.method === "GET") return "agent_operation_unknown";
  if (operationId.startsWith("ai") || operationId.startsWith("aurora"))
    return "agent_operation_unknown";
  if (spec.scopes.some((s) => RESTRICTED_GROUPS.has(s))) return "agent_operation_restricted";
  if (spec.scopes.length === 0 || spec.scopes.some((s) => !grant.includes(s)))
    return "agent_outside_grant";
  return spec;
}

/** Where a confirmation comes from: the org whose Connected apps page the person used, and that request's headers. */
export interface ApplyContext {
  readonly org: { readonly id: string; readonly slug: string };
  readonly incoming: Pick<Headers, "get">;
}

export async function applyAgentProposal(
  db: XosClient,
  suggestionId: string,
  context: ApplyContext,
): Promise<ApplyOutcome> {
  const proposal = await getProposalForApply(db, suggestionId);
  if (!proposal.ok) {
    const e = proposal.error;
    return { ok: false, rule: e.kind === "refusal" ? e.rule : "ai_suggestion_not_proposed" };
  }
  // The page lists only its own org's proposals, so another org's id here was not offered to the person.
  if (proposal.data.orgId !== context.org.id)
    return { ok: false, rule: "ai_suggestion_not_proposed" };
  const allowed = operationAllowed(proposal.data.operationId, proposal.data.grantScopes);
  if (typeof allowed === "string") return { ok: false, rule: allowed };
  const { data: session } = await db.auth.getSession();
  const token = session.session?.access_token;
  if (!token) return { ok: false, rule: "ai_suggestion_needs_person" };

  const confirmed = await transitionAiSuggestion(db, {
    id: suggestionId,
    expected: "Proposed",
    next: "Confirmed",
    reason: "Confirmed in Connected apps.",
  });
  if (!confirmed.ok) {
    return {
      ok: false,
      rule:
        confirmed.error.kind === "refusal" ? confirmed.error.rule : "ai_suggestion_not_proposed",
    };
  }

  const site = env().ATLAS_SITE_URL.replace(/\/$/, "");
  const client = new ApiClient({
    baseUrl: `${site}/api/v1`,
    maxRetries: 0,
    fetch: inProcessSessionFetch(context.incoming, {
      accessToken: token,
      orgSlug: context.org.slug,
      siteOrigin: site,
    }),
  });
  const fields = proposal.data.fields;
  const body = fields.length > 0 ? bodyFromFields(fields) : undefined;
  let appliedId: string;
  try {
    const response = await client.request(
      allowed,
      { path: proposal.data.request.path, ...(body ? { body } : {}) },
      {
        idempotencyKey: suggestionId,
        ...(proposal.data.request.ifMatch ? { ifMatch: proposal.data.request.ifMatch } : {}),
      },
    );
    const data = response.data as { id?: unknown } | null | undefined;
    appliedId = typeof data?.id === "string" ? data.id : (proposal.data.targetId ?? suggestionId);
  } catch (error) {
    const back = await transitionAiSuggestion(db, {
      id: suggestionId,
      expected: "Confirmed",
      next: "Proposed",
      reason: "The API refused the change.",
    });
    if (!back.ok)
      observability.logger.error("an agent proposal stayed Confirmed after a refusal", {
        suggestionId,
      });
    if (error instanceof XosApiError) {
      const problem = error.problem as { status?: number; detail?: string; title?: string };
      if (problem.status === 412 || problem.status === 428) return { ok: false, rule: "stale" };
      return {
        ok: false,
        rule: "other",
        detail: problem.detail ?? problem.title ?? `HTTP ${String(problem.status)}`,
      };
    }
    throw error;
  }
  const applied = await transitionAiSuggestion(db, {
    id: suggestionId,
    expected: "Confirmed",
    next: "Applied",
    reason: "Applied through the public API.",
    appliedId,
  });
  if (!applied.ok) {
    observability.logger.error("an applied agent proposal could not be marked Applied", {
      suggestionId,
    });
  }
  return { ok: true, appliedId };
}

/** Rejects a proposal (the person withdraws it). */
export async function rejectAgentProposal(
  db: XosClient,
  suggestionId: string,
): Promise<ApplyOutcome> {
  const rejected = await transitionAiSuggestion(db, {
    id: suggestionId,
    expected: "Proposed",
    next: "Rejected",
    reason: "Rejected in Connected apps.",
  });
  if (!rejected.ok) {
    return {
      ok: false,
      rule: rejected.error.kind === "refusal" ? rejected.error.rule : "ai_suggestion_not_proposed",
    };
  }
  return { ok: true, appliedId: suggestionId };
}
