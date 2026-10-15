import type { XosClient } from "./client.ts";
import type { Result } from "./result.ts";
import { untyped } from "./untyped.ts";
import {
  args,
  callId,
  list,
  memberName,
  MEMBER_EMBED,
  num,
  rows,
  single,
  str,
  strOrNull,
  type Raw,
} from "./workforce-shared.ts";

/**
 * The help desk (Section 4.9 Help desk; migration 0805), imported as `@xos/data/workforce-help-desk`.
 * Requests to internal teams (operations, IT, HR, facilities) are tickets of A31's Organization
 * support queue routed to a team with its first response target; team members read, assign, answer
 * and resolve them. Teams are set up by org.help.write holders.
 */

export type HelpDeskTeamKind = "Operations" | "IT" | "HR" | "Facilities" | "Other";
export type SupportCategory =
  "Question" | "Problem" | "Access" | "Billing" | "Account" | "Feature Request";
export type SupportSeverity = "Severity 1" | "Severity 2" | "Severity 3" | "Severity 4";
export type SupportTicketState = "Open" | "Waiting" | "Resolved" | "Closed";

export const HELP_DESK_TEAM_KINDS: readonly HelpDeskTeamKind[] = [
  "Operations",
  "IT",
  "HR",
  "Facilities",
  "Other",
];
export const SUPPORT_CATEGORIES: readonly SupportCategory[] = [
  "Question",
  "Problem",
  "Access",
  "Billing",
  "Account",
  "Feature Request",
];
export const SUPPORT_SEVERITIES: readonly SupportSeverity[] = [
  "Severity 1",
  "Severity 2",
  "Severity 3",
  "Severity 4",
];

/** Responder moves of a request from each state. */
export const HELP_DESK_NEXT: Readonly<Record<SupportTicketState, readonly SupportTicketState[]>> = {
  Open: ["Waiting", "Resolved", "Closed"],
  Waiting: ["Open", "Resolved", "Closed"],
  Resolved: ["Open", "Closed"],
  Closed: [],
};

export interface HelpDeskTeam {
  readonly id: string;
  readonly name: string;
  readonly kind: HelpDeskTeamKind;
  readonly description: string | null;
  readonly firstResponseHours: number;
  readonly archivedAt: string | null;
  readonly members: readonly { id: string; membershipId: string; name: string | null }[];
}

export async function listHelpDeskTeams(
  db: XosClient,
  orgId: string,
): Promise<Result<HelpDeskTeam[]>> {
  return rows(
    untyped(db)
      .from("help_desk_teams")
      .select(
        `id, name, team_kind, description, first_response_hours, archived_at,
         help_desk_team_members(id, membership_id, deleted_at, membership:memberships(${MEMBER_EMBED}))`,
      )
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("name"),
    (r) => ({
      id: str(r["id"]),
      name: str(r["name"]),
      kind: str(r["team_kind"]) as HelpDeskTeamKind,
      description: strOrNull(r["description"]),
      firstResponseHours: num(r["first_response_hours"]),
      archivedAt: strOrNull(r["archived_at"]),
      members: list(r["help_desk_team_members"])
        .filter((m) => m["deleted_at"] === null)
        .map((m) => ({
          id: str(m["id"]),
          membershipId: str(m["membership_id"]),
          name: memberName(m["membership"]),
        })),
    }),
  );
}

export async function createHelpDeskTeam(
  db: XosClient,
  orgId: string,
  input: {
    readonly name: string;
    readonly kind: HelpDeskTeamKind;
    readonly description?: string | null;
    readonly firstResponseHours: number;
  },
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("help_desk_teams")
      .insert({
        org_id: orgId,
        name: input.name,
        team_kind: input.kind,
        description: input.description ?? null,
        first_response_hours: input.firstResponseHours,
      })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function archiveHelpDeskTeam(
  db: XosClient,
  teamId: string,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("help_desk_teams")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", teamId)
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function addHelpDeskTeamMember(
  db: XosClient,
  teamId: string,
  membershipId: string,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("help_desk_team_members")
      .insert({ help_desk_team_id: teamId, membership_id: membershipId })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function removeHelpDeskTeamMember(
  db: XosClient,
  teamMemberId: string,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("help_desk_team_members")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", teamMemberId)
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export interface HelpDeskRequest {
  readonly id: string;
  readonly number: string;
  readonly teamId: string | null;
  readonly category: SupportCategory;
  readonly severity: SupportSeverity;
  readonly subject: string;
  readonly body: string;
  readonly state: SupportTicketState;
  readonly requesterMembershipId: string;
  readonly requesterName: string | null;
  readonly assigneeMembershipId: string | null;
  readonly assigneeName: string | null;
  readonly responseDueAt: string | null;
  readonly firstRespondedAt: string | null;
  readonly createdAt: string;
}

function toRequest(r: Raw): HelpDeskRequest {
  return {
    id: str(r["id"]),
    number: str(r["ticket_number"]),
    teamId: strOrNull(r["help_desk_team_id"]),
    category: str(r["category"]) as SupportCategory,
    severity: str(r["severity"]) as SupportSeverity,
    subject: str(r["subject"]),
    body: str(r["body"]),
    state: str(r["ticket_state"]) as SupportTicketState,
    requesterMembershipId: str(r["membership_id"]),
    requesterName: memberName(r["requester"]),
    assigneeMembershipId: strOrNull(r["assignee_membership_id"]),
    assigneeName: memberName(r["assignee"]),
    responseDueAt: strOrNull(r["help_desk_response_due_at"]),
    firstRespondedAt: strOrNull(r["first_responded_at"]),
    createdAt: str(r["created_at"]),
  };
}

/** Help desk requests the viewer reads (their own, their teams', or all for admins), newest first. */
export async function listHelpDeskRequests(
  db: XosClient,
  orgId: string,
): Promise<Result<HelpDeskRequest[]>> {
  return rows(
    untyped(db)
      .from("support_tickets")
      .select(
        `id, ticket_number, help_desk_team_id, category, severity, subject, body, ticket_state, membership_id, assignee_membership_id,
         help_desk_response_due_at, first_responded_at, created_at,
         requester:memberships!support_tickets_membership_id_fkey(${MEMBER_EMBED}),
         assignee:memberships!support_tickets_assignee_membership_id_fkey(${MEMBER_EMBED})`,
      )
      .eq("org_id", orgId)
      .eq("queue", "Organization")
      .not("help_desk_team_id", "is", null)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    toRequest,
  );
}

export interface HelpDeskMessage {
  readonly id: string;
  readonly authorMembershipId: string | null;
  readonly authorName: string | null;
  readonly body: string;
  readonly createdAt: string;
}

export async function listHelpDeskMessages(
  db: XosClient,
  ticketId: string,
): Promise<Result<HelpDeskMessage[]>> {
  return rows(
    untyped(db)
      .from("support_ticket_messages")
      .select(`id, author_membership_id, body, created_at, author:memberships(${MEMBER_EMBED})`)
      .eq("support_ticket_id", ticketId)
      .order("created_at"),
    (r) => ({
      id: str(r["id"]),
      authorMembershipId: strOrNull(r["author_membership_id"]),
      authorName: memberName(r["author"]),
      body: str(r["body"]),
      createdAt: str(r["created_at"]),
    }),
  );
}

export async function openHelpDeskRequest(
  db: XosClient,
  orgId: string,
  input: {
    readonly teamId: string;
    readonly category: SupportCategory;
    readonly subject: string;
    readonly body: string;
    readonly severity?: SupportSeverity;
  },
): Promise<Result<{ id: string }>> {
  return callId(db, "open_help_desk_request", {
    p_org_id: orgId,
    p_help_desk_team_id: input.teamId,
    p_category: input.category,
    p_subject: input.subject,
    p_body: input.body,
    ...args({ p_severity: input.severity }),
  });
}

export async function assignHelpDeskRequest(
  db: XosClient,
  ticketId: string,
  assigneeMembershipId: string | null,
  teamId?: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "assign_help_desk_request", {
    p_ticket_id: ticketId,
    p_assignee_membership_id: assigneeMembershipId,
    ...args({ p_help_desk_team_id: teamId }),
  });
}

export async function answerHelpDeskRequest(
  db: XosClient,
  ticketId: string,
  body: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "answer_help_desk_request", { p_ticket_id: ticketId, p_body: body });
}

export async function transitionHelpDeskRequest(
  db: XosClient,
  ticketId: string,
  expected: SupportTicketState,
  next: SupportTicketState,
  reason: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "transition_help_desk_request", {
    p_ticket_id: ticketId,
    p_expected: expected,
    p_next: next,
    p_reason: reason,
  });
}

/** Whether a request is past its first response deadline without an answer. */
export function responseOverdue(
  r: Pick<HelpDeskRequest, "responseDueAt" | "firstRespondedAt" | "state">,
  now: Date = new Date(),
): boolean {
  return (
    r.firstRespondedAt === null &&
    r.responseDueAt !== null &&
    (r.state === "Open" || r.state === "Waiting") &&
    Date.parse(r.responseDueAt) < now.getTime()
  );
}
