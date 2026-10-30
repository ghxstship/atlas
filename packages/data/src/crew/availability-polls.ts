import type { XosClient } from "../client.ts";
import type { Json } from "../database.types.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";

/**
 * Availability polls (P8, migration 2853, ADR 0063): a planner (crew.shift.write on the project)
 * asks members and engaged freelancers for their availability on chosen days, and each recipient
 * answers day by day. Answers are availability blocks on the recipient's calendar kept for the org,
 * tagged with the poll, so app.rank_shift_candidates reads them like any other period. Row level
 * security and the RPCs decide every row: planners read every poll of their projects and its
 * results, a recipient reads the polls addressed to them and their own recipient row.
 */

export type AvailabilityAnswer = "Available" | "Tentative" | "Unavailable";
export const AVAILABILITY_ANSWERS: readonly AvailabilityAnswer[] = [
  "Available",
  "Tentative",
  "Unavailable",
];

/** How a recipient stands on a day of a poll: their answer, or Unstated. */
export type PollAvailability = AvailabilityAnswer | "Unstated";

/** Asks people for their availability; returns the poll id. Every rule is the database's. */
export async function sendAvailabilityPoll(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly title: string;
    /** Project-local YYYY-MM-DD days, 1 to 31. */
    readonly days: readonly string[];
    readonly personIds: readonly string[];
    readonly message?: string | null;
    readonly closesAt?: string | null;
  },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("send_availability_poll", {
    p_project_id: input.projectId,
    p_title: input.title.trim(),
    p_days: [...input.days],
    p_person_ids: [...input.personIds],
    ...(input.message?.trim() ? { p_message: input.message.trim() } : {}),
    ...(input.closesAt ? { p_closes_at: input.closesAt } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

/** One answered day: `written` is false when the org's notice lock already holds the day. */
export interface PollAnswerResult {
  readonly day: string;
  readonly kind: AvailabilityAnswer;
  readonly written: boolean;
}

/** Writes the signed-in recipient's answers; a later answer for a day replaces the earlier one. */
export async function answerAvailabilityPoll(
  db: XosClient,
  input: {
    readonly pollId: string;
    readonly answers: readonly { readonly day: string; readonly kind: AvailabilityAnswer }[];
  },
): Promise<Result<PollAnswerResult[]>> {
  const { data, error } = await db.rpc("answer_availability_poll", {
    p_poll_id: input.pollId,
    p_answers: input.answers.map((a) => ({ day: a.day, kind: a.kind })) as unknown as Json,
  });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      day: r.day,
      kind: r.availability_kind as AvailabilityAnswer,
      written: r.written,
    })),
  );
}

/** One recipient on one day of a poll, as planners read it. Notes never appear. */
export interface PollResultCell {
  readonly personId: string;
  readonly name: string | null;
  readonly day: string;
  readonly availability: PollAvailability;
  /** The poll's own answer covers the day, rather than a period stated elsewhere. */
  readonly answeredByPoll: boolean;
  /** When the recipient last answered the poll; null until they do. */
  readonly respondedAt: string | null;
}

/** The person-by-day results of a poll, for the project's planners (crew.shift.write). */
export async function availabilityPollResults(
  db: XosClient,
  pollId: string,
): Promise<Result<PollResultCell[]>> {
  const { data, error } = await db.rpc("availability_poll_results", { p_poll_id: pollId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      personId: r.person_id,
      name: r.full_name ?? null,
      day: r.day,
      availability: r.availability as PollAvailability,
      answeredByPoll: r.answered_by_poll,
      respondedAt: r.responded_at ?? null,
    })),
  );
}

/** An open poll addressed to the signed-in person, with each day still to come. */
export interface AvailabilityRequest {
  readonly pollId: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly projectName: string;
  readonly title: string;
  readonly message: string | null;
  readonly closesAt: string | null;
  readonly respondedAt: string | null;
  readonly days: readonly {
    readonly day: string;
    readonly answer: AvailabilityAnswer | null;
    /** The org's notice lock already holds the day: it can no longer be answered here. */
    readonly locked: boolean;
  }[];
}

/** The open polls addressed to the signed-in person, one entry per poll, days in order. */
export async function myAvailabilityRequests(
  db: XosClient,
): Promise<Result<AvailabilityRequest[]>> {
  const { data, error } = await db.rpc("my_availability_requests");
  if (error) return fail(toDataError(error));
  const polls = new Map<
    string,
    AvailabilityRequest & { days: AvailabilityRequest["days"][number][] }
  >();
  for (const r of data ?? []) {
    let poll = polls.get(r.poll_id);
    if (!poll) {
      poll = {
        pollId: r.poll_id,
        orgId: r.org_id,
        orgName: r.org_name,
        projectName: r.project_name,
        title: r.title,
        message: r.message ?? null,
        closesAt: r.closes_at ?? null,
        respondedAt: r.responded_at ?? null,
        days: [],
      };
      polls.set(r.poll_id, poll);
    }
    poll.days.push({
      day: r.day,
      answer: (r.answer as AvailabilityAnswer | null) ?? null,
      locked: r.locked,
    });
  }
  return ok([...polls.values()]);
}

/** A poll of a project, as its planners list it. Open or closed is computed from closesAt. */
export interface AvailabilityPoll {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly message: string | null;
  readonly closesAt: string | null;
  readonly createdAt: string;
  readonly days: readonly string[];
  readonly recipientCount: number;
}

/** The live polls of the given projects the caller may read, newest first. */
export async function listAvailabilityPolls(
  db: XosClient,
  projectIds: readonly string[],
): Promise<Result<AvailabilityPoll[]>> {
  if (projectIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("availability_polls")
    .select(
      "id, project_id, title, message, closes_at, created_at, days:availability_poll_days(day, deleted_at), recipients:availability_poll_recipients(id, deleted_at)",
    )
    .in("project_id", [...projectIds])
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((p) => ({
      id: p.id,
      projectId: p.project_id,
      title: p.title,
      message: p.message ?? null,
      closesAt: p.closes_at ?? null,
      createdAt: p.created_at,
      days: (p.days ?? [])
        .filter((d) => d.deleted_at === null)
        .map((d) => d.day)
        .sort(),
      recipientCount: (p.recipients ?? []).filter((r) => r.deleted_at === null).length,
    })),
  );
}

/** Whether a poll still takes answers. */
export function pollIsOpen(
  poll: { readonly closesAt: string | null },
  now: Date = new Date(),
): boolean {
  return poll.closesAt === null || Date.parse(poll.closesAt) > now.getTime();
}

/** Someone a planner can ask: an active member, or a person engaged by the org. */
export interface PollablePerson {
  readonly personId: string;
  readonly name: string | null;
  readonly engaged: boolean;
}

/**
 * The people a poll can be addressed to, through row level security: the org's active members and
 * the people holding an engagement with it in Onboarding, Blocked, Active or Closing.
 */
export async function listPollablePeople(
  db: XosClient,
  orgId: string,
  now: Date = new Date(),
): Promise<Result<PollablePerson[]>> {
  const at = now.toISOString();
  const [members, engaged] = await Promise.all([
    db
      .from("memberships")
      .select("person_id, person:people!memberships_person_id_fkey(full_name)")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .lte("valid_from", at)
      .or(`valid_to.is.null,valid_to.gt.${at}`),
    db
      .from("engagements")
      .select("person_id, person:people!engagements_person_id_fkey(full_name)")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .not("person_id", "is", null)
      .in("engagement_state", ["Onboarding", "Blocked", "Active", "Closing"]),
  ]);
  if (members.error) return fail(toDataError(members.error));
  if (engaged.error) return fail(toDataError(engaged.error));
  const people = new Map<string, PollablePerson>();
  for (const m of members.data ?? []) {
    people.set(m.person_id, {
      personId: m.person_id,
      name: m.person?.full_name ?? null,
      engaged: false,
    });
  }
  for (const e of engaged.data ?? []) {
    if (e.person_id && !people.has(e.person_id)) {
      people.set(e.person_id, {
        personId: e.person_id,
        name: e.person?.full_name ?? null,
        engaged: true,
      });
    }
  }
  return ok([...people.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")));
}
