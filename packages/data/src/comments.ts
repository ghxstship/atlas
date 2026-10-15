import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Comments repository (Section 7.3: one unified comment system for every module). Threads and comments
 * are keyed by subject table and subject id; row level security follows the subject's own read policy
 * (migration 0580), so a module passes its row and gets exactly the comments its caller may see.
 * Posting goes through app.post_comment, which creates the thread on first use and records mentions;
 * the database stamps authors, keeps the edit history, notifies and emits events.
 */

type Tables = Database["app"]["Tables"];
export type CommentSource = Database["app"]["Enums"]["comment_source"];

/** The row a thread or attachment belongs to, for example { table: "app.records", id }. */
export interface Subject {
  readonly table: string;
  readonly id: string;
}

export interface Reaction {
  readonly code: string;
  readonly personId: string;
}

export interface Comment {
  readonly id: string;
  readonly authorPersonId: string;
  /** Empty once deleted. */
  readonly body: string;
  readonly source: CommentSource;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
  readonly mentionedPersonIds: readonly string[];
  readonly reactions: readonly Reaction[];
}

export interface Thread {
  readonly id: string;
  /** What part of the subject the thread is anchored to, or null for the main thread. */
  readonly anchor: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  /** Oldest first. */
  readonly comments: readonly Comment[];
}

export interface CommentVersion {
  readonly versionNumber: number;
  readonly body: string;
  readonly createdAt: string;
}

type ThreadRow = Pick<
  Tables["comment_threads"]["Row"],
  "id" | "anchor" | "resolved_at" | "resolved_by"
> & {
  comments:
    | (Pick<
        Tables["comments"]["Row"],
        "id" | "author_person_id" | "body" | "source" | "created_at" | "edited_at" | "deleted_at"
      > & {
        comment_mentions:
          Pick<Tables["comment_mentions"]["Row"], "mentioned_person_id" | "deleted_at">[] | null;
        comment_reactions:
          | Pick<Tables["comment_reactions"]["Row"], "reaction_code" | "person_id" | "deleted_at">[]
          | null;
      })[]
    | null;
};

const THREAD_COLUMNS =
  "id, anchor, resolved_at, resolved_by, comments(id, author_person_id, body, source, created_at, edited_at, deleted_at, comment_mentions(mentioned_person_id, deleted_at), comment_reactions(reaction_code, person_id, deleted_at))";

function toThread(row: ThreadRow): Thread {
  const comments = [...(row.comments ?? [])]
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    .map((c): Comment => ({
      id: c.id,
      authorPersonId: c.author_person_id,
      body: c.body,
      source: c.source,
      createdAt: c.created_at,
      editedAt: c.edited_at,
      deletedAt: c.deleted_at,
      mentionedPersonIds: (c.comment_mentions ?? [])
        .filter((m) => m.deleted_at === null)
        .map((m) => m.mentioned_person_id),
      reactions: (c.comment_reactions ?? [])
        .filter((r) => r.deleted_at === null)
        .map((r) => ({ code: r.reaction_code, personId: r.person_id })),
    }));
  return {
    id: row.id,
    anchor: row.anchor,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    comments,
  };
}

/** Every thread on a subject the caller may read, main thread first, each with its comments. */
export async function listThreads(db: XosClient, subject: Subject): Promise<Result<Thread[]>> {
  const { data, error } = await db
    .from("comment_threads")
    .select(THREAD_COLUMNS)
    .eq("subject_table", subject.table)
    .eq("subject_id", subject.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) return fail(toDataError(error));
  const threads = (data as unknown as ThreadRow[]).map(toThread);
  return ok(threads.sort((a, b) => (a.anchor === null ? -1 : b.anchor === null ? 1 : 0)));
}

export interface PostComment {
  readonly subject: Subject;
  readonly body: string;
  /** People to mention; each must be able to open the subject. */
  readonly mentions?: readonly string[];
  /** Thread anchor; omit for the main thread. */
  readonly anchor?: string;
}

/** Posts a comment; returns its id. Refusals (for example a mention of someone without access) come back typed. */
export async function postComment(db: XosClient, input: PostComment): Promise<Result<string>> {
  const { data, error } = await db.rpc("post_comment", {
    p_subject_table: input.subject.table,
    p_subject_id: input.subject.id,
    p_body: input.body,
    p_mentions: [...(input.mentions ?? [])],
    ...(input.anchor === undefined ? {} : { p_anchor: input.anchor }),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

async function updateOwnComment(
  db: XosClient,
  commentId: string,
  patch: Tables["comments"]["Update"],
): Promise<Result<void>> {
  const { data, error } = await db.from("comments").update(patch).eq("id", commentId).select("id");
  if (error) return fail(toDataError(error));
  if (!data || data.length === 0) return fail({ kind: "not-found" });
  return ok(undefined);
}

/** Edits the caller's own comment; the earlier text goes to the history. */
export function editComment(db: XosClient, commentId: string, body: string): Promise<Result<void>> {
  return updateOwnComment(db, commentId, { body });
}

/** Deletes the caller's own comment (soft: the text is cleared from view and kept in the history). */
export function deleteComment(
  db: XosClient,
  commentId: string,
  now: Date = new Date(),
): Promise<Result<void>> {
  return updateOwnComment(db, commentId, { deleted_at: now.toISOString() });
}

/** The edit history of the caller's own comment (or any comment, for readers of the audit log). */
export async function listCommentVersions(
  db: XosClient,
  commentId: string,
): Promise<Result<CommentVersion[]>> {
  const { data, error } = await db
    .from("comment_versions")
    .select("version_number, body, created_at")
    .eq("comment_id", commentId)
    .order("version_number", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((v) => ({
      versionNumber: v.version_number,
      body: v.body,
      createdAt: v.created_at,
    })),
  );
}

/** Adds the caller's reaction to a comment. */
export async function addReaction(
  db: XosClient,
  commentId: string,
  code: string,
): Promise<Result<void>> {
  // person_id is stamped from the session by the database, never sent by the caller.
  const row = {
    comment_id: commentId,
    reaction_code: code,
  } as Tables["comment_reactions"]["Insert"];
  const { error } = await db.from("comment_reactions").insert(row);
  if (error) return fail(toDataError(error));
  return ok(undefined);
}

/** Removes the caller's reaction (soft). Removing a reaction that is not there is not an error. */
export async function removeReaction(
  db: XosClient,
  commentId: string,
  code: string,
  now: Date = new Date(),
): Promise<Result<void>> {
  const { error } = await db
    .from("comment_reactions")
    .update({ deleted_at: now.toISOString() })
    .eq("comment_id", commentId)
    .eq("reaction_code", code)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(undefined);
}

/** Follows or mutes a thread for the caller. */
export async function setSubscription(
  db: XosClient,
  threadId: string,
  subscribed: boolean,
): Promise<Result<void>> {
  const { error } = await db.rpc("set_thread_subscription", {
    p_comment_thread_id: threadId,
    p_subscribed: subscribed,
  });
  if (error) return fail(toDataError(error));
  return ok(undefined);
}

/** Resolves or reopens a thread; the database stamps who and when. */
export async function setThreadResolved(
  db: XosClient,
  threadId: string,
  resolved: boolean,
  now: Date = new Date(),
): Promise<Result<void>> {
  const { data, error } = await db
    .from("comment_threads")
    .update({ resolved_at: resolved ? now.toISOString() : null })
    .eq("id", threadId)
    .select("id");
  if (error) return fail(toDataError(error));
  if (!data || data.length === 0) return fail({ kind: "not-found" });
  return ok(undefined);
}
