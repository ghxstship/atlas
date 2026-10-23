import type { XosClient } from "./client.ts";
import type { Result } from "./result.ts";
import { bool, num, rpc, str, strOrNull, type Raw } from "./platform-common.ts";

/**
 * Reporting and blocking (owner decision 19, App Store Review Guideline 1.2; migrations 1630 and 1631), imported as
 * `@xos/data/content-safety`. A person reports a feed post, a comment on a post or a chat message to the org's
 * moderators, and blocks the person behind a membership: a block hides that person's posts, comments on posts,
 * shout-outs and messages from the blocker in every read, so nothing here filters. The moderators (members holding
 * org.communication.write) read their queue in Atlas and decide each item with a statement of reasons in parts, as
 * A90's console does for listings. Listing and lifting blocks are access-controls' listMyBlocks and unblock.
 */

export type ContentSubjectKind = "Feed Post" | "Comment" | "Chat Message";
export type ContentReportReason =
  "Harassment" | "Hate" | "Sexual Content" | "Violence" | "Spam" | "Other";
export type ContentModerationAction = "Removed" | "No Action";
export type ContentModerationGround = "Illegal Content" | "Terms Violation" | "No Violation";

/** The reasons in the order a reporter is offered them. */
export const CONTENT_REPORT_REASONS: readonly ContentReportReason[] = [
  "Harassment",
  "Hate",
  "Sexual Content",
  "Violence",
  "Spam",
  "Other",
];

export const CONTENT_SUBJECT_KINDS: readonly ContentSubjectKind[] = [
  "Feed Post",
  "Comment",
  "Chat Message",
];

/** How many hours the moderators have to decide a report (app.content_reports.due_at). */
export const REPORT_RESPONSE_HOURS = 24;

/** Something a person can report: what it is and its id. */
export interface ContentTarget {
  readonly kind: ContentSubjectKind;
  readonly id: string;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Raw =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {};

/**
 * Reports an item to the org's moderators with a reason and optional details. Reporting it again while the first
 * report is open returns that report; one's own content and content already removed are refused.
 */
export async function reportContent(
  db: XosClient,
  target: ContentTarget,
  reason: ContentReportReason,
  details?: string | null,
): Promise<Result<string>> {
  const trimmed = details?.trim() ?? "";
  return rpc(
    db,
    "report_content",
    {
      p_subject_kind: target.kind,
      p_subject_id: target.id,
      p_reason: reason,
      p_details: trimmed === "" ? null : trimmed,
    },
    str,
  );
}

/** Blocks the person behind a membership in one of the caller's orgs. Idempotent; returns the block id. */
export async function blockMember(db: XosClient, membershipId: string): Promise<Result<string>> {
  return rpc(db, "block_member", { p_membership_id: membershipId }, str);
}

// The moderators' queue -------------------------------------------------------------------------------------------

export interface ContentQueueItem {
  readonly kind: ContentSubjectKind;
  readonly id: string;
  readonly authorPersonId: string | null;
  readonly authorName: string | null;
  /** The text as it was last reported. */
  readonly excerpt: string;
  readonly removed: boolean;
  readonly openReports: number;
  readonly totalReports: number;
  readonly reasons: readonly ContentReportReason[];
  readonly firstReportedAt: string | null;
  /** When a decision is due: 24 hours after the oldest open report; null once all are decided. */
  readonly dueAt: string | null;
  readonly overdue: boolean;
  readonly lastAction: ContentModerationAction | null;
  readonly lastDecidedAt: string | null;
}

/**
 * The org moderators' queue: items with open reports, the one due first at the top; or, with `open` false, the
 * decided items, newest decision first. Refused without org.communication.write.
 */
export async function listContentModerationQueue(
  db: XosClient,
  orgId: string,
  open = true,
): Promise<Result<ContentQueueItem[]>> {
  return rpc(db, "content_moderation_queue", { p_org_id: orgId, p_open: open }, (data) =>
    arr(data).map((d) => {
      const r = obj(d);
      return {
        kind: str(r["subject_kind"]) as ContentSubjectKind,
        id: str(r["subject_id"]),
        authorPersonId: strOrNull(r["author_person_id"]),
        authorName: strOrNull(r["author_name"]),
        excerpt: str(r["content_excerpt"]),
        removed: bool(r["removed"]),
        openReports: num(r["open_reports"]),
        totalReports: num(r["total_reports"]),
        reasons: arr(r["reasons"]).map((x) => str(x) as ContentReportReason),
        firstReportedAt: strOrNull(r["first_reported_at"]),
        dueAt: strOrNull(r["due_at"]),
        overdue: bool(r["overdue"]),
        lastAction: strOrNull(r["last_action"]) as ContentModerationAction | null,
        lastDecidedAt: strOrNull(r["last_decided_at"]),
      };
    }),
  );
}

export interface ContentReportDetail {
  readonly subject: {
    readonly kind: ContentSubjectKind;
    readonly id: string;
    /** Where it was posted: the post's title or kind, or the group or conversation kind. */
    readonly context: string | null;
    readonly authorPersonId: string | null;
    readonly authorName: string | null;
    /** The current text; null once removed. */
    readonly body: string | null;
    readonly removed: boolean;
    /** False when the signed-in moderator wrote it: another moderator decides. */
    readonly decidableByMe: boolean;
  };
  readonly reports: readonly {
    readonly id: string;
    readonly reason: ContentReportReason;
    readonly details: string | null;
    readonly excerpt: string;
    readonly reportedAt: string;
    readonly dueAt: string;
    readonly reporterName: string | null;
    readonly open: boolean;
  }[];
  readonly decisions: readonly {
    readonly id: string;
    readonly action: ContentModerationAction;
    readonly ground: ContentModerationGround;
    readonly ruleReference: string;
    readonly facts: string;
    readonly statement: string;
    readonly decidedAt: string;
    readonly decidedByName: string | null;
  }[];
}

/** Parses app.content_report_detail's document. */
export function parseContentReportDetail(raw: unknown): ContentReportDetail {
  const d = obj(raw);
  const s = obj(d["subject"]);
  return {
    subject: {
      kind: str(s["kind"]) as ContentSubjectKind,
      id: str(s["id"]),
      context: strOrNull(s["context"]),
      authorPersonId: strOrNull(s["author_person_id"]),
      authorName: strOrNull(s["author_name"]),
      body: strOrNull(s["body"]),
      removed: bool(s["removed"]),
      decidableByMe: bool(s["decidable_by_me"]),
    },
    reports: arr(d["reports"]).map((x) => {
      const r = obj(x);
      return {
        id: str(r["id"]),
        reason: str(r["reason"]) as ContentReportReason,
        details: strOrNull(r["details"]),
        excerpt: str(r["content_excerpt"]),
        reportedAt: str(r["reported_at"]),
        dueAt: str(r["due_at"]),
        reporterName: strOrNull(r["reporter_name"]),
        open: bool(r["open"]),
      };
    }),
    decisions: arr(d["decisions"]).map((x) => {
      const r = obj(x);
      return {
        id: str(r["id"]),
        action: str(r["action"]) as ContentModerationAction,
        ground: str(r["ground"]) as ContentModerationGround,
        ruleReference: str(r["rule_reference"]),
        facts: str(r["facts"]),
        statement: str(r["statement"]),
        decidedAt: str(r["decided_at"]),
        decidedByName: strOrNull(r["decided_by_name"]),
      };
    }),
  };
}

/** One reported item with every report and decision, for a moderator. */
export async function getContentReportDetail(
  db: XosClient,
  orgId: string,
  target: ContentTarget,
): Promise<Result<ContentReportDetail>> {
  return rpc(
    db,
    "content_report_detail",
    { p_org_id: orgId, p_subject_kind: target.kind, p_subject_id: target.id },
    parseContentReportDetail,
  );
}

/** The grounds a decision fits: a removal needs a violation, no action needs none. */
export function contentGroundsFor(
  action: ContentModerationAction,
): readonly ContentModerationGround[] {
  return action === "Removed" ? ["Terms Violation", "Illegal Content"] : ["No Violation"];
}

export interface ContentDecision {
  readonly action: ContentModerationAction;
  readonly ground: ContentModerationGround;
  readonly ruleReference: string;
  readonly facts: string;
  readonly statement: string;
}

/**
 * Decides every open report on an item: Removed hides the post or deletes the comment or message, No Action leaves
 * it. The reporters hear the outcome and, on removal, the author receives the statement. Returns the decision id.
 */
export async function decideContentReport(
  db: XosClient,
  orgId: string,
  target: ContentTarget,
  decision: ContentDecision,
): Promise<Result<string>> {
  return rpc(
    db,
    "decide_content_report",
    {
      p_org_id: orgId,
      p_subject_kind: target.kind,
      p_subject_id: target.id,
      p_action: decision.action,
      p_ground: decision.ground,
      p_rule_reference: decision.ruleReference,
      p_facts: decision.facts,
      p_statement: decision.statement,
    },
    str,
  );
}
