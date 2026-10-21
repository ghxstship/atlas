import type { XosClient } from "./client.ts";
import { fail, ok, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";
import {
  args,
  audienceArgs,
  audienceOf,
  bool,
  call,
  callId,
  callRows,
  list,
  memberName,
  MEMBER_EMBED,
  num,
  numOrNull,
  rows,
  single,
  str,
  strings,
  strOrNull,
  type Audience,
  type Raw,
} from "./workforce-shared.ts";

/**
 * The feed, polls, pulse surveys and recognition (Section 4.9; migrations 0801 and 0805), imported
 * as `@xos/data/workforce-feed`. Posts are written through the feed RPCs: posting needs
 * knowledge.document.write, pinning and required acknowledgment knowledge.sop.publish, moderation
 * org.communication.write. Anonymous survey answers carry no respondent and results show only once
 * the minimum number of responses is met. Recognition posts to the feed and never carries points.
 */

export type FeedPostKind = "Announcement" | "Update" | "Poll" | "Recognition";
export type SurveyState = "Draft" | "Open" | "Closed";
export type SurveyQuestionKind = "Scale" | "Choice" | "Text";

export const FEED_POST_KINDS: readonly FeedPostKind[] = [
  "Announcement",
  "Update",
  "Poll",
  "Recognition",
];
export const AUTHORED_POST_KINDS: readonly FeedPostKind[] = ["Announcement", "Update", "Poll"];
export const SURVEY_STATES: readonly SurveyState[] = ["Draft", "Open", "Closed"];
export const REACTION_CODES = [
  "thumbs_up",
  "heart",
  "check",
  "eyes",
  "laugh",
  "celebrate",
] as const;
export type ReactionCode = (typeof REACTION_CODES)[number];

export interface PollOption {
  readonly id: string;
  readonly position: number;
  readonly label: string;
}

export interface Poll {
  readonly id: string;
  readonly question: string;
  readonly allowsMultiple: boolean;
  readonly closesAt: string | null;
  readonly options: readonly PollOption[];
  /** Options the viewer chose; empty until they vote. */
  readonly myChoices: readonly string[];
}

export interface FeedPost {
  readonly id: string;
  readonly kind: FeedPostKind;
  readonly title: string | null;
  readonly body: string;
  readonly audience: Audience;
  readonly authorMembershipId: string | null;
  readonly authorName: string | null;
  readonly pinnedAt: string | null;
  readonly requiresAcknowledgment: boolean;
  readonly reactionsEnabled: boolean;
  readonly commentsEnabled: boolean;
  readonly publishAt: string;
  readonly hiddenAt: string | null;
  readonly hiddenReason: string | null;
  readonly acknowledgedByMe: boolean;
  readonly reactions: Readonly<Record<string, number>>;
  readonly myReactions: readonly string[];
  readonly poll: Poll | null;
}

const POST_COLUMNS = `id, post_kind, title, body, audience_kind, project_id, team_id, role_id, group_id, department_code, author_membership_id,
  pinned_at, requires_acknowledgment, reactions_enabled, comments_enabled, publish_at, hidden_at, hidden_reason,
  author:memberships(${MEMBER_EMBED}), feed_reactions(membership_id, reaction_code, deleted_at),
  polls(id, question, allows_multiple, closes_at, poll_options(id, position, label, deleted_at))`;

function toPost(
  r: Raw,
  mine: ReadonlySet<string>,
  acked: ReadonlySet<string>,
  votes: ReadonlyMap<string, string[]>,
): FeedPost {
  const reactions: Record<string, number> = {};
  const myReactions: string[] = [];
  for (const x of list(r["feed_reactions"])) {
    if (x["deleted_at"] !== null) continue;
    const code = str(x["reaction_code"]);
    reactions[code] = (reactions[code] ?? 0) + 1;
    if (mine.has(str(x["membership_id"]))) myReactions.push(code);
  }
  const p =
    list(r["polls"])[0] ?? (r["polls"] && !Array.isArray(r["polls"]) ? (r["polls"] as Raw) : null);
  const poll: Poll | null = p
    ? {
        id: str(p["id"]),
        question: str(p["question"]),
        allowsMultiple: bool(p["allows_multiple"]),
        closesAt: strOrNull(p["closes_at"]),
        options: list(p["poll_options"])
          .filter((o) => o["deleted_at"] === null)
          .map((o) => ({ id: str(o["id"]), position: num(o["position"]), label: str(o["label"]) }))
          .sort((a, b) => a.position - b.position),
        myChoices: votes.get(str(p["id"])) ?? [],
      }
    : null;
  return {
    id: str(r["id"]),
    kind: str(r["post_kind"]) as FeedPostKind,
    title: strOrNull(r["title"]),
    body: str(r["body"]),
    audience: audienceOf(r),
    authorMembershipId: strOrNull(r["author_membership_id"]),
    authorName: memberName(r["author"]),
    pinnedAt: strOrNull(r["pinned_at"]),
    requiresAcknowledgment: bool(r["requires_acknowledgment"]),
    reactionsEnabled: bool(r["reactions_enabled"]),
    commentsEnabled: bool(r["comments_enabled"]),
    publishAt: str(r["publish_at"]),
    hiddenAt: strOrNull(r["hidden_at"]),
    hiddenReason: strOrNull(r["hidden_reason"]),
    acknowledgedByMe: acked.has(str(r["id"])),
    reactions,
    myReactions,
    poll,
  };
}

/** Pinned posts first, then newest published first. */
export function feedOrder(
  a: Pick<FeedPost, "pinnedAt" | "publishAt">,
  b: Pick<FeedPost, "pinnedAt" | "publishAt">,
): number {
  if ((a.pinnedAt === null) !== (b.pinnedAt === null)) return a.pinnedAt === null ? 1 : -1;
  return b.publishAt.localeCompare(a.publishAt);
}

/**
 * The feed posts the viewer reads in an org (optionally one project), pinned first, with reaction
 * counts, the viewer's reactions, acknowledgment and poll votes.
 */
export async function listFeed(
  db: XosClient,
  orgId: string,
  myMembershipIds: readonly string[],
  options: { readonly projectId?: string | null; readonly limit?: number } = {},
): Promise<Result<FeedPost[]>> {
  let query = untyped(db)
    .from("feed_posts")
    .select(POST_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("publish_at", { ascending: false })
    .limit(options.limit ?? 100);
  if (options.projectId) query = query.eq("project_id", options.projectId);
  const posts = await rows(query, (r) => r);
  if (!posts.ok) return posts;
  const ids = posts.data.map((p) => str(p["id"]));
  const [acks, votes] = await Promise.all([
    ids.length === 0
      ? Promise.resolve(ok<Raw[]>([]))
      : rows(
          untyped(db)
            .from("feed_acknowledgments")
            .select("feed_post_id")
            .in("feed_post_id", ids)
            .in("membership_id", [...myMembershipIds]),
          (r) => r,
        ),
    ids.length === 0
      ? Promise.resolve(ok<Raw[]>([]))
      : rows(
          untyped(db)
            .from("poll_votes")
            .select("poll_id, poll_option_id")
            .in("membership_id", [...myMembershipIds]),
          (r) => r,
        ),
  ]);
  if (!acks.ok) return acks;
  if (!votes.ok) return votes;
  const acked = new Set(acks.data.map((a) => str(a["feed_post_id"])));
  const myVotes = new Map<string, string[]>();
  for (const v of votes.data) {
    const poll = str(v["poll_id"]);
    myVotes.set(poll, [...(myVotes.get(poll) ?? []), str(v["poll_option_id"])]);
  }
  const mine = new Set(myMembershipIds);
  return ok(posts.data.map((p) => toPost(p, mine, acked, myVotes)).sort(feedOrder));
}

export interface FeedPostInput {
  readonly kind: FeedPostKind;
  readonly body: string;
  readonly title?: string | null;
  readonly audience?: Partial<Audience>;
  readonly pinned?: boolean;
  readonly requiresAcknowledgment?: boolean;
  readonly reactionsEnabled?: boolean;
  readonly commentsEnabled?: boolean;
  readonly publishAt?: string | null;
  readonly poll?: {
    readonly question: string;
    readonly options: readonly string[];
    readonly allowsMultiple?: boolean;
    readonly closesAt?: string | null;
  } | null;
}

/** Posts to the feed; a future publish time schedules the post. */
export async function createFeedPost(
  db: XosClient,
  orgId: string,
  input: FeedPostInput,
): Promise<Result<{ id: string }>> {
  return callId(db, "create_feed_post", {
    p_org_id: orgId,
    p_post_kind: input.kind,
    p_body: input.body,
    ...args({
      p_title: input.title ?? undefined,
      p_pinned: input.pinned,
      p_requires_acknowledgment: input.requiresAcknowledgment,
      p_reactions_enabled: input.reactionsEnabled,
      p_comments_enabled: input.commentsEnabled,
      p_publish_at: input.publishAt ?? undefined,
      p_poll: input.poll
        ? args({
            question: input.poll.question,
            options: [...input.poll.options],
            allows_multiple: input.poll.allowsMultiple ?? false,
            closes_at: input.poll.closesAt ?? undefined,
          })
        : undefined,
    }),
    ...audienceArgs(input.audience),
    ...args({ p_department_code: input.audience?.departmentCode ?? undefined }),
  });
}

/** Pins or unpins a post, turns its reactions or comments on or off, or moves its schedule. */
export async function updateFeedPost(
  db: XosClient,
  postId: string,
  changes: {
    readonly pinned?: boolean;
    readonly reactionsEnabled?: boolean;
    readonly commentsEnabled?: boolean;
    readonly publishAt?: string;
  },
): Promise<Result<{ id: string }>> {
  return callId(
    db,
    "update_feed_post",
    args({
      p_post_id: postId,
      p_pinned: changes.pinned,
      p_reactions_enabled: changes.reactionsEnabled,
      p_comments_enabled: changes.commentsEnabled,
      p_publish_at: changes.publishAt,
    }),
  );
}

/** Hides a post with a reason. */
export async function hideFeedPost(
  db: XosClient,
  postId: string,
  reason: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "hide_feed_post", { p_post_id: postId, p_reason: reason });
}

/** Acknowledges a post that requires it. */
export async function acknowledgeFeedPost(
  db: XosClient,
  postId: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "acknowledge_feed_post", { p_post_id: postId });
}

/** Adds or removes the viewer's reaction. */
export async function reactToFeedPost(
  db: XosClient,
  postId: string,
  code: ReactionCode,
  on: boolean,
): Promise<Result<boolean>> {
  return call<boolean>(db, "react_to_feed_post", {
    p_post_id: postId,
    p_reaction_code: code,
    p_on: on,
  });
}

export interface AcknowledgmentStatus {
  readonly membershipId: string;
  readonly personId: string;
  readonly name: string;
  readonly acknowledgedAt: string | null;
}

/** Who in a post's audience acknowledged it, outstanding first (author and admins). */
export async function listAcknowledgmentStatus(
  db: XosClient,
  postId: string,
): Promise<Result<AcknowledgmentStatus[]>> {
  return callRows(db, "feed_acknowledgment_status", { p_post_id: postId }, (r) => ({
    membershipId: str(r["membership_id"]),
    personId: str(r["person_id"]),
    name: str(r["full_name"]),
    acknowledgedAt: strOrNull(r["acknowledged_at"]),
  }));
}

/** Votes once in a poll. */
export async function voteInPoll(
  db: XosClient,
  pollId: string,
  optionIds: readonly string[],
): Promise<Result<number>> {
  return call<number>(db, "vote_in_poll", { p_poll_id: pollId, p_option_ids: [...optionIds] });
}

export interface PollResult {
  readonly optionId: string;
  readonly position: number;
  readonly label: string;
  readonly votes: number;
  readonly voters: number;
}

export async function getPollResults(db: XosClient, pollId: string): Promise<Result<PollResult[]>> {
  return callRows(db, "poll_results", { p_poll_id: pollId }, (r) => ({
    optionId: str(r["poll_option_id"]),
    position: num(r["option_position"]),
    label: str(r["label"]),
    votes: num(r["votes"]),
    voters: num(r["voters"]),
  }));
}

/** A share of votes as a whole percent; 0 with no voters. */
export function votePercent(votes: number, voters: number): number {
  return voters <= 0 ? 0 : Math.round((100 * votes) / voters);
}

// Surveys -----------------------------------------------------------------------------------------

export interface SurveyQuestion {
  readonly id: string;
  readonly position: number;
  readonly prompt: string;
  readonly kind: SurveyQuestionKind;
  readonly choices: readonly string[];
  readonly scaleMax: number | null;
  readonly required: boolean;
}

export interface Survey {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly audience: Audience;
  readonly authorMembershipId: string | null;
  readonly anonymous: boolean;
  readonly minResponses: number;
  readonly state: SurveyState;
  readonly closesAt: string | null;
  readonly createdAt: string;
  readonly questions: readonly SurveyQuestion[];
  readonly respondedByMe: boolean;
}

/** Surveys the viewer reads, newest first, with their questions and whether the viewer responded. */
export async function listSurveys(
  db: XosClient,
  orgId: string,
  myMembershipIds: readonly string[],
): Promise<Result<Survey[]>> {
  const [surveys, mine] = await Promise.all([
    rows(
      untyped(db)
        .from("surveys")
        .select(
          "id, title, description, audience_kind, project_id, team_id, role_id, group_id, author_membership_id, is_anonymous, min_responses, survey_state, closes_at, created_at, survey_questions(id, position, prompt, question_kind, choices, scale_max, is_required, deleted_at)",
        )
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
      (r) => r,
    ),
    rows(
      untyped(db)
        .from("survey_participations")
        .select("survey_id")
        .in("membership_id", [...myMembershipIds]),
      (r) => r,
    ),
  ]);
  if (!surveys.ok) return surveys;
  if (!mine.ok) return mine;
  const responded = new Set(mine.data.map((m) => str(m["survey_id"])));
  return ok(
    surveys.data.map((r): Survey => ({
      id: str(r["id"]),
      title: str(r["title"]),
      description: strOrNull(r["description"]),
      audience: audienceOf(r),
      authorMembershipId: strOrNull(r["author_membership_id"]),
      anonymous: bool(r["is_anonymous"]),
      minResponses: num(r["min_responses"]),
      state: str(r["survey_state"]) as SurveyState,
      closesAt: strOrNull(r["closes_at"]),
      createdAt: str(r["created_at"]),
      questions: list(r["survey_questions"])
        .filter((q) => q["deleted_at"] === null)
        .map((q) => ({
          id: str(q["id"]),
          position: num(q["position"]),
          prompt: str(q["prompt"]),
          kind: str(q["question_kind"]) as SurveyQuestionKind,
          choices: strings(q["choices"]),
          scaleMax: numOrNull(q["scale_max"]),
          required: bool(q["is_required"]),
        }))
        .sort((a, b) => a.position - b.position),
      respondedByMe: responded.has(str(r["id"])),
    })),
  );
}

export interface SurveyQuestionInput {
  readonly prompt: string;
  readonly kind: SurveyQuestionKind;
  readonly choices?: readonly string[];
  readonly scaleMax?: 5 | 10;
  readonly required?: boolean;
}

export interface SurveyInput {
  readonly title: string;
  readonly description?: string | null;
  readonly audience?: Partial<Audience>;
  readonly anonymous?: boolean;
  readonly minResponses?: number;
  readonly closesAt?: string | null;
  readonly questions: readonly SurveyQuestionInput[];
}

/** Checks survey questions before the database does, so the builder explains the problem. */
export function surveyProblems(questions: readonly SurveyQuestionInput[]): string[] {
  const problems: string[] = [];
  if (questions.length === 0 || questions.length > 50) problems.push("questionCount");
  questions.forEach((q, i) => {
    if (q.prompt.trim() === "") problems.push(`prompt:${i}`);
    if (q.kind === "Choice" && ((q.choices?.length ?? 0) < 2 || (q.choices?.length ?? 0) > 10))
      problems.push(`choices:${i}`);
  });
  return problems;
}

/** Drafts a survey with its questions. */
export async function createSurvey(
  db: XosClient,
  orgId: string,
  input: SurveyInput,
): Promise<Result<{ id: string }>> {
  if (surveyProblems(input.questions).length > 0) {
    return fail({ kind: "invalid", message: surveyProblems(input.questions).join(",") });
  }
  return callId(db, "create_survey", {
    p_org_id: orgId,
    p_title: input.title,
    p_questions: input.questions.map((q) =>
      args({
        prompt: q.prompt,
        kind: q.kind,
        choices: q.kind === "Choice" ? [...(q.choices ?? [])] : undefined,
        scale_max: q.kind === "Scale" ? (q.scaleMax ?? 5) : undefined,
        required: q.required ?? true,
      }),
    ),
    ...args({
      p_description: input.description ?? undefined,
      p_is_anonymous: input.anonymous,
      p_min_responses: input.minResponses,
      p_closes_at: input.closesAt ?? undefined,
    }),
    ...audienceArgs(input.audience),
  });
}

/** Opens a draft survey or closes an open one. */
export async function transitionSurvey(
  db: XosClient,
  surveyId: string,
  expected: SurveyState,
  next: SurveyState,
  reason: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "transition_survey", {
    p_survey_id: surveyId,
    p_expected: expected,
    p_next: next,
    p_reason: reason,
  });
}

/** Responds once; returns null for an anonymous survey so nothing links the caller to the answers. */
export async function respondToSurvey(
  db: XosClient,
  surveyId: string,
  answers: Readonly<Record<string, string | number>>,
): Promise<Result<{ id: string | null }>> {
  const result = await call<string | null>(db, "respond_to_survey", {
    p_survey_id: surveyId,
    p_answers: answers,
  });
  return result.ok ? ok({ id: result.data }) : result;
}

export interface SurveyQuestionResult {
  readonly questionId: string;
  readonly position: number;
  readonly prompt: string;
  readonly kind: SurveyQuestionKind;
  readonly scaleMax: number | null;
  readonly answered: number;
  readonly average: number | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly texts: readonly string[];
}

export interface SurveyResults {
  readonly responses: number;
  readonly minResponses: number;
  readonly thresholdMet: boolean;
  readonly audience: number;
  readonly questions: readonly SurveyQuestionResult[];
}

/** Survey results for its author and managers, empty below the threshold. */
export async function getSurveyResults(
  db: XosClient,
  surveyId: string,
): Promise<Result<SurveyResults>> {
  const result = await call<Raw>(db, "survey_results", { p_survey_id: surveyId });
  if (!result.ok) return result;
  const r = result.data;
  return ok({
    responses: num(r["responses"]),
    minResponses: num(r["min_responses"]),
    thresholdMet: bool(r["threshold_met"]),
    audience: num(r["audience"]),
    questions: list(r["questions"]).map((q) => ({
      questionId: str(q["question_id"]),
      position: num(q["position"]),
      prompt: str(q["prompt"]),
      kind: str(q["kind"]) as SurveyQuestionKind,
      scaleMax: numOrNull(q["scale_max"]),
      answered: num(q["answered"]),
      average: numOrNull(q["average"]),
      counts: Object.fromEntries(
        Object.entries((q["counts"] as Record<string, unknown> | null) ?? {}).map(([k, v]) => [
          k,
          num(v),
        ]),
      ),
      texts: strings(q["texts"]),
    })),
  });
}

/** Response rate as a whole percent of the audience; null with an empty audience. */
export function responseRate(
  results: Pick<SurveyResults, "responses" | "audience">,
): number | null {
  return results.audience <= 0 ? null : Math.round((100 * results.responses) / results.audience);
}

// Recognition -------------------------------------------------------------------------------------

export interface Recognition {
  readonly id: string;
  readonly fromMembershipId: string;
  readonly fromName: string | null;
  readonly toMembershipId: string;
  readonly toName: string | null;
  readonly projectId: string | null;
  readonly shiftId: string | null;
  readonly message: string;
  readonly feedPostId: string | null;
  readonly createdAt: string;
}

/** Recognitions the viewer reads in an org, newest first. */
export async function listRecognitions(
  db: XosClient,
  orgId: string,
): Promise<Result<Recognition[]>> {
  return rows(
    untyped(db)
      .from("recognitions")
      .select(
        `id, from_membership_id, to_membership_id, project_id, shift_id, message, feed_post_id, created_at,
         giver:memberships!recognitions_from_membership_id_fkey(${MEMBER_EMBED}),
         receiver:memberships!recognitions_to_membership_id_fkey(${MEMBER_EMBED})`,
      )
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    (r) => ({
      id: str(r["id"]),
      fromMembershipId: str(r["from_membership_id"]),
      fromName: memberName(r["giver"]),
      toMembershipId: str(r["to_membership_id"]),
      toName: memberName(r["receiver"]),
      projectId: strOrNull(r["project_id"]),
      shiftId: strOrNull(r["shift_id"]),
      message: str(r["message"]),
      feedPostId: strOrNull(r["feed_post_id"]),
      createdAt: str(r["created_at"]),
    }),
  );
}

/** Recognizes a colleague, optionally for a project or a shift they worked. */
export async function recognize(
  db: XosClient,
  orgId: string,
  input: {
    readonly toMembershipId: string;
    readonly message: string;
    readonly projectId?: string | null;
    readonly shiftId?: string | null;
  },
): Promise<Result<{ id: string }>> {
  return callId(db, "recognize", {
    p_org_id: orgId,
    p_to_membership_id: input.toMembershipId,
    p_message: input.message,
    ...args({ p_project_id: input.projectId ?? undefined, p_shift_id: input.shiftId ?? undefined }),
  });
}

/** A person's recognition count when they consented to show it; null otherwise. */
export async function getRecognitionCount(
  db: XosClient,
  orgId: string,
  personId: string,
): Promise<Result<number | null>> {
  const result = await call<number | null>(db, "recognition_count", {
    p_org_id: orgId,
    p_person_id: personId,
  });
  return result.ok ? ok(result.data === null ? null : num(result.data)) : result;
}

/** Whether the person consented to show their recognition count on their profile in this org. */
export async function getRecognitionConsent(
  db: XosClient,
  orgId: string,
  personId: string,
): Promise<Result<{ id: string } | null>> {
  const result = await rows(
    untyped(db)
      .from("consent_records")
      .select("id")
      .eq("org_id", orgId)
      .eq("person_id", personId)
      .eq("purpose_code", "recognition_profile")
      .is("withdrawn_at", null)
      .is("deleted_at", null),
    (r) => ({ id: str(r["id"]) }),
  );
  return result.ok ? ok(result.data[0] ?? null) : result;
}

/** Gives (true) or withdraws (false) consent to show the recognition count on the profile. */
export async function setRecognitionConsent(
  db: XosClient,
  orgId: string,
  personId: string,
  consent: boolean,
): Promise<Result<{ id: string } | null>> {
  if (consent) {
    return single(
      untyped(db)
        .from("consent_records")
        .insert({
          org_id: orgId,
          person_id: personId,
          purpose_code: "recognition_profile",
          notice_version: "2026-10",
          source: "Web",
        })
        .select("id")
        .single(),
      (r) => ({ id: str(r["id"]) }),
    );
  }
  const current = await getRecognitionConsent(db, orgId, personId);
  if (!current.ok || current.data === null) return current;
  return single(
    untyped(db)
      .from("consent_records")
      .update({ withdrawn_at: new Date().toISOString() })
      .eq("id", current.data.id)
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}
