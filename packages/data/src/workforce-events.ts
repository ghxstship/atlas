import type { XosClient } from "./client.ts";
import type { Result } from "./result.ts";
import { untyped } from "./untyped.ts";
import {
  audienceColumns,
  audienceOf,
  args,
  callId,
  list,
  memberName,
  MEMBER_EMBED,
  rows,
  single,
  str,
  strOrNull,
  bool,
  type Audience,
  type Raw,
} from "./workforce-shared.ts";
import type { Database } from "./database.types.ts";
import * as enums from "./enums.generated.ts";

/**
 * Briefings, crew calls and meetings with RSVP, location, agenda and check-in (Section 4.9 Events;
 * migration 0802), imported as `@xos/data/workforce-events`. Org events need schedule.timeline.write
 * org-wide, project events on the project. Invitees RSVP and check in from an hour before the start;
 * the organizer checks anyone in the audience in by hand or from a scan.
 */

export type WorkforceEventKind = Database["app"]["Enums"]["workforce_event_kind"];
export type RsvpResponse = Database["app"]["Enums"]["rsvp_response"];
export type CheckInMethod = Database["app"]["Enums"]["check_in_method"];

export const WORKFORCE_EVENT_KINDS: readonly WorkforceEventKind[] = enums.workforceEventKind;
export const RSVP_RESPONSES: readonly RsvpResponse[] = enums.rsvpResponse;

export interface WorkforceEvent {
  readonly id: string;
  readonly kind: WorkforceEventKind;
  readonly title: string;
  readonly agenda: string | null;
  readonly location: string | null;
  readonly venueId: string | null;
  readonly spaceId: string | null;
  readonly audience: Audience;
  readonly organizerMembershipId: string | null;
  readonly organizerName: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly rsvpRequired: boolean;
  readonly canceledAt: string | null;
  readonly cancelReason: string | null;
  readonly rsvps: readonly { membershipId: string; name: string | null; response: RsvpResponse }[];
  readonly checkIns: readonly {
    membershipId: string;
    name: string | null;
    method: CheckInMethod;
    at: string;
  }[];
}

function toEvent(r: Raw): WorkforceEvent {
  return {
    id: str(r["id"]),
    kind: str(r["event_kind"]) as WorkforceEventKind,
    title: str(r["title"]),
    agenda: strOrNull(r["agenda"]),
    location: strOrNull(r["location"]),
    venueId: strOrNull(r["venue_id"]),
    spaceId: strOrNull(r["space_id"]),
    audience: audienceOf(r),
    organizerMembershipId: strOrNull(r["organizer_membership_id"]),
    organizerName: memberName(r["organizer"]),
    startsAt: str(r["starts_at"]),
    endsAt: str(r["ends_at"]),
    rsvpRequired: bool(r["rsvp_required"]),
    canceledAt: strOrNull(r["canceled_at"]),
    cancelReason: strOrNull(r["cancel_reason"]),
    rsvps: list(r["event_rsvps"]).map((x) => ({
      membershipId: str(x["membership_id"]),
      name: memberName(x["membership"]),
      response: str(x["response"]) as RsvpResponse,
    })),
    checkIns: list(r["event_check_ins"]).map((x) => ({
      membershipId: str(x["membership_id"]),
      name: memberName(x["membership"]),
      method: str(x["check_in_method"]) as CheckInMethod,
      at: str(x["checked_in_at"]),
    })),
  };
}

const EVENT_COLUMNS = `id, event_kind, title, agenda, location, venue_id, space_id, audience_kind, project_id, team_id, role_id, group_id,
  organizer_membership_id, starts_at, ends_at, rsvp_required, canceled_at, cancel_reason,
  organizer:memberships(${MEMBER_EMBED}),
  event_rsvps(membership_id, response, membership:memberships(${MEMBER_EMBED})),
  event_check_ins(membership_id, check_in_method, checked_in_at, membership:memberships(${MEMBER_EMBED}))`;

/** Events the viewer reads, soonest first, optionally from a time on. */
export async function listWorkforceEvents(
  db: XosClient,
  orgId: string,
  options: { readonly from?: string; readonly projectId?: string | null } = {},
): Promise<Result<WorkforceEvent[]>> {
  let query = untyped(db)
    .from("workforce_events")
    .select(EVENT_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("starts_at");
  if (options.from) query = query.gte("ends_at", options.from);
  if (options.projectId) query = query.eq("project_id", options.projectId);
  return rows(query, toEvent);
}

export interface WorkforceEventInput {
  readonly kind: WorkforceEventKind;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly agenda?: string | null;
  readonly location?: string | null;
  readonly venueId?: string | null;
  readonly spaceId?: string | null;
  readonly audience?: Partial<Audience>;
  readonly rsvpRequired?: boolean;
}

/** Schedules an event as its organizer; the audience is invited. */
export async function createWorkforceEvent(
  db: XosClient,
  orgId: string,
  organizerMembershipId: string,
  input: WorkforceEventInput,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("workforce_events")
      .insert({
        org_id: orgId,
        organizer_membership_id: organizerMembershipId,
        event_kind: input.kind,
        title: input.title,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        agenda: input.agenda ?? null,
        location: input.location ?? null,
        venue_id: input.venueId ?? null,
        space_id: input.spaceId ?? null,
        rsvp_required: input.rsvpRequired ?? true,
        ...audienceColumns(input.audience),
      })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

/** Edits the title, time, place or agenda of an event. */
export async function updateWorkforceEvent(
  db: XosClient,
  eventId: string,
  changes: Partial<
    Pick<WorkforceEventInput, "title" | "startsAt" | "endsAt" | "agenda" | "location">
  >,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("workforce_events")
      .update(
        args({
          title: changes.title,
          starts_at: changes.startsAt,
          ends_at: changes.endsAt,
          agenda: changes.agenda,
          location: changes.location,
        }),
      )
      .eq("id", eventId)
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

/** Cancels an event with a reason. */
export async function cancelWorkforceEvent(
  db: XosClient,
  eventId: string,
  reason: string,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("workforce_events")
      .update({ canceled_at: new Date().toISOString(), cancel_reason: reason })
      .eq("id", eventId)
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function rsvpToEvent(
  db: XosClient,
  eventId: string,
  response: RsvpResponse,
): Promise<Result<{ id: string }>> {
  return callId(db, "rsvp_to_event", { p_event_id: eventId, p_response: response });
}

/** Checks in the viewer, or another invitee when the viewer organizes the event. */
export async function checkInToEvent(
  db: XosClient,
  eventId: string,
  membershipId?: string,
  method: CheckInMethod = "Self",
): Promise<Result<{ id: string }>> {
  return callId(
    db,
    "check_in_to_event",
    args({ p_event_id: eventId, p_membership_id: membershipId, p_method: method }),
  );
}

/** Whether check-in is open: from an hour before the start until the end. */
export function checkInOpen(
  event: Pick<WorkforceEvent, "startsAt" | "endsAt" | "canceledAt">,
  now: Date = new Date(),
): boolean {
  if (event.canceledAt !== null) return false;
  const t = now.getTime();
  return t >= Date.parse(event.startsAt) - 3_600_000 && t <= Date.parse(event.endsAt);
}

/** RSVP counts by response. */
export function rsvpCounts(event: Pick<WorkforceEvent, "rsvps">): Record<RsvpResponse, number> {
  const counts: Record<RsvpResponse, number> = { Going: 0, Maybe: 0, Declined: 0 };
  for (const r of event.rsvps) counts[r.response] += 1;
  return counts;
}

/** The viewer's RSVP. */
export function myRsvp(
  event: Pick<WorkforceEvent, "rsvps">,
  myMembershipIds: readonly string[],
): RsvpResponse | null {
  return event.rsvps.find((r) => myMembershipIds.includes(r.membershipId))?.response ?? null;
}

/** The event's state for display: canceled, past, live (check-in open) or upcoming. */
export function eventPhase(
  event: Pick<WorkforceEvent, "startsAt" | "endsAt" | "canceledAt">,
  now: Date = new Date(),
): "canceled" | "past" | "live" | "upcoming" {
  if (event.canceledAt !== null) return "canceled";
  if (Date.parse(event.endsAt) < now.getTime()) return "past";
  return checkInOpen(event, now) ? "live" : "upcoming";
}
