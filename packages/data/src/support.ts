import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import * as enums from "./enums.generated.ts";

/**
 * Support tickets (Section 11.16, migration 0643). Members ask their own org's admins (Organization
 * queue); org admins (org.help.write) ask the platform team (Platform queue), with the channel and
 * first response deadline their plan includes. Diagnostics go only with consent. Tickets open, take
 * messages and move state through the RPCs, which decide every refusal.
 */

type Enums = Database["app"]["Enums"];
export type SupportQueue = Enums["support_queue"];
export type SupportTicketState = Enums["support_ticket_state"];
export type SupportSeverity = Enums["support_severity"];
export type SupportCategory = Enums["support_category"];
export type SupportChannel = Enums["support_channel"];

export const SUPPORT_CATEGORIES: readonly SupportCategory[] = enums.supportCategory;
export const SUPPORT_SEVERITIES: readonly SupportSeverity[] = enums.supportSeverity;

export interface Diagnostics {
  readonly route: string | null;
  readonly appVersion: string | null;
  readonly device: string | null;
  readonly recentErrors: string | null;
  readonly screenshotPath: string | null;
}

export interface SupportTicket {
  readonly id: string;
  readonly number: string;
  readonly queue: SupportQueue;
  readonly category: SupportCategory;
  readonly severity: SupportSeverity;
  readonly subject: string;
  readonly body: string;
  readonly state: SupportTicketState;
  readonly channel: SupportChannel;
  readonly firstResponseDueAt: string | null;
  readonly firstRespondedAt: string | null;
  readonly createdAt: string;
  /** Membership of the person who asked. */
  readonly requesterMembershipId: string;
  readonly requesterName: string | null;
}

export interface SupportMessage {
  readonly id: string;
  /** Null for the platform support team. */
  readonly authorMembershipId: string | null;
  readonly authorName: string | null;
  readonly body: string;
  readonly createdAt: string;
}

export interface SupportTicketDetail extends SupportTicket {
  readonly diagnostics: (Diagnostics & { readonly consentedAt: string }) | null;
  readonly messages: readonly SupportMessage[];
  /** The states the ticket may move to next (app.lifecycle_transition_rules). */
  readonly nextStates: readonly SupportTicketState[];
}

const TICKET_COLUMNS: string =
  "id, ticket_number, queue, category, severity, subject, body, ticket_state, channel, " +
  "first_response_due_at, first_responded_at, created_at, membership_id, " +
  "memberships!support_tickets_membership_id_fkey (people!memberships_person_id_fkey (full_name))";

interface TicketRow {
  id: string;
  ticket_number: string;
  queue: SupportQueue;
  category: SupportCategory;
  severity: SupportSeverity;
  subject: string;
  body: string;
  ticket_state: SupportTicketState;
  channel: SupportChannel;
  first_response_due_at: string | null;
  first_responded_at: string | null;
  created_at: string;
  membership_id: string;
  memberships: { people: { full_name: string | null } | null } | null;
}

function toTicket(row: TicketRow): SupportTicket {
  return {
    id: row.id,
    number: row.ticket_number,
    queue: row.queue,
    category: row.category,
    severity: row.severity,
    subject: row.subject,
    body: row.body,
    state: row.ticket_state,
    channel: row.channel,
    firstResponseDueAt: row.first_response_due_at,
    firstRespondedAt: row.first_responded_at,
    createdAt: row.created_at,
    requesterMembershipId: row.membership_id,
    requesterName: row.memberships?.people?.full_name ?? null,
  };
}

/**
 * The tickets the signed-in person reads in an org, newest first: their own, and every ticket of
 * the org when they answer support (org.help.write). Filter by queue, state or requester.
 */
export async function listSupportTickets(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly queue?: SupportQueue;
    readonly states?: readonly SupportTicketState[];
    readonly requesterMembershipId?: string;
  },
): Promise<Result<SupportTicket[]>> {
  let query = db
    .from("support_tickets")
    .select(TICKET_COLUMNS)
    .eq("org_id", input.orgId)
    .is("deleted_at", null);
  if (input.queue) query = query.eq("queue", input.queue);
  if (input.states && input.states.length > 0) query = query.in("ticket_state", [...input.states]);
  if (input.requesterMembershipId) query = query.eq("membership_id", input.requesterMembershipId);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(((data ?? []) as unknown as TicketRow[]).map(toTicket));
}

/** One ticket with its diagnostics, its conversation and the states it may move to. */
export async function getSupportTicket(
  db: XosClient,
  ticketId: string,
): Promise<Result<SupportTicketDetail>> {
  const ticket = await db
    .from("support_tickets")
    .select(TICKET_COLUMNS)
    .eq("id", ticketId)
    .is("deleted_at", null)
    .maybeSingle();
  if (ticket.error) return fail(toDataError(ticket.error));
  if (!ticket.data) return fail({ kind: "not-found" });
  const row = ticket.data as unknown as TicketRow;
  const [diagnostics, messages, rules] = await Promise.all([
    db
      .from("support_ticket_diagnostics")
      .select("consented_at, route, app_version, device, recent_errors, screenshot_path")
      .eq("support_ticket_id", ticketId)
      .maybeSingle(),
    db
      .from("support_ticket_messages")
      .select(
        "id, author_membership_id, body, created_at, memberships!support_ticket_messages_author_membership_id_fkey (people!memberships_person_id_fkey (full_name))",
      )
      .eq("support_ticket_id", ticketId)
      .order("created_at"),
    db
      .from("lifecycle_transition_rules")
      .select("to_state")
      .eq("lifecycle", "support_ticket")
      .eq("from_state", row.ticket_state),
  ]);
  if (diagnostics.error) return fail(toDataError(diagnostics.error));
  if (messages.error) return fail(toDataError(messages.error));
  if (rules.error) return fail(toDataError(rules.error));
  const d = diagnostics.data;
  const messageRows = (messages.data ?? []) as unknown as {
    id: string;
    author_membership_id: string | null;
    body: string;
    created_at: string;
    memberships: { people: { full_name: string | null } | null } | null;
  }[];
  return ok({
    ...toTicket(row),
    diagnostics: d
      ? {
          consentedAt: d.consented_at,
          route: d.route,
          appVersion: d.app_version,
          device: d.device,
          recentErrors: d.recent_errors,
          screenshotPath: d.screenshot_path,
        }
      : null,
    messages: messageRows.map((m) => ({
      id: m.id,
      authorMembershipId: m.author_membership_id,
      authorName: m.memberships?.people?.full_name ?? null,
      body: m.body,
      createdAt: m.created_at,
    })),
    nextStates: (rules.data ?? []).map((r) => r.to_state as SupportTicketState),
  });
}

/** Opens a ticket (app.open_support_ticket). Diagnostics are sent only when given, with consent. */
export async function openSupportTicket(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly queue: SupportQueue;
    readonly category: SupportCategory;
    readonly severity?: SupportSeverity;
    readonly subject: string;
    readonly body: string;
    readonly diagnostics?: Partial<Diagnostics> | null;
  },
): Promise<Result<string>> {
  const d = input.diagnostics;
  const { data, error } = await db.rpc("open_support_ticket", {
    p_org_id: input.orgId,
    p_queue: input.queue,
    p_category: input.category,
    p_subject: input.subject,
    p_body: input.body,
    ...(input.severity ? { p_severity: input.severity } : {}),
    ...(d
      ? {
          p_diagnostics: {
            consent: true,
            route: d.route ?? null,
            app_version: d.appVersion ?? null,
            device: d.device ?? null,
            recent_errors: d.recentErrors ?? null,
            screenshot_path: d.screenshotPath ?? null,
          },
        }
      : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

/** Adds a message to a ticket (app.post_support_message). */
export async function postSupportMessage(
  db: XosClient,
  ticketId: string,
  body: string,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("post_support_message", {
    p_support_ticket_id: ticketId,
    p_body: body,
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

/** Moves a ticket to its next state with a reason (app.transition_support_ticket). */
export async function transitionSupportTicket(
  db: XosClient,
  input: {
    readonly ticketId: string;
    readonly expected: SupportTicketState;
    readonly next: SupportTicketState;
    readonly reason: string;
  },
): Promise<Result<null>> {
  const { error } = await db.rpc("transition_support_ticket", {
    p_support_ticket_id: input.ticketId,
    p_expected: input.expected,
    p_next: input.next,
    p_reason: input.reason,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

// Account support (migration 1300) ---------------------------------------------------------------

/**
 * What a person may ask platform support about their own account (Section 11.16). Everything else
 * belongs to an org, which external parties reach through Messages and members through Contact
 * Support.
 */
export const ACCOUNT_SUPPORT_CATEGORIES = ["Account", "Access", "Problem", "Question"] as const;
export type AccountSupportCategory = (typeof ACCOUNT_SUPPORT_CATEGORIES)[number];

export interface AccountSupportRequest {
  readonly number: string;
  readonly category: AccountSupportCategory;
  readonly subject: string;
  readonly state: SupportTicketState;
  readonly createdAt: string;
}

/**
 * Sends platform support a request about the signed-in person's own account
 * (app.open_account_support_request). Diagnostics are sent only when given, with consent. Returns the
 * request number; platform support answers by email.
 */
export async function openAccountSupportRequest(
  db: XosClient,
  input: {
    readonly category: AccountSupportCategory;
    readonly subject: string;
    readonly body: string;
    readonly diagnostics?: Partial<Diagnostics> | null;
  },
): Promise<Result<string>> {
  const d = input.diagnostics;
  const { data, error } = await db.rpc("open_account_support_request", {
    p_category: input.category,
    p_subject: input.subject,
    p_body: input.body,
    ...(d
      ? {
          p_diagnostics: {
            consent: true,
            route: d.route ?? null,
            app_version: d.appVersion ?? null,
            device: d.device ?? null,
            recent_errors: d.recentErrors ?? null,
            screenshot_path: d.screenshotPath ?? null,
          },
        }
      : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

/** The signed-in person's own account support requests, newest first. */
export async function listMyAccountSupportRequests(
  db: XosClient,
): Promise<Result<AccountSupportRequest[]>> {
  const { data, error } = await db.rpc("my_account_support_requests");
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      number: r.request_number,
      category: r.category as AccountSupportCategory,
      subject: r.subject,
      state: r.request_state,
      createdAt: r.created_at,
    })),
  );
}
