import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Show channels (B3, ADR 0142 decision 9; migration 2922): a project's crew chat beside the running cue, a Project
 * group marked show_channel, one live per project. Clients are never in it: the database refuses to add one, hides
 * the channel from a member who becomes one, and never notifies one. The messages themselves are the group's chat
 * (workforce-chat.ts listMessages and sendMessage, app.send_chat_message).
 *
 * Group row level security hides a group from people outside it, so the panel asks app.show_channel_status what it
 * may offer.
 */

export interface ShowChannelStatus {
  /** The project has a live show channel. */
  readonly exists: boolean;
  /** Its conversation, only for a member of it. */
  readonly conversationId: string | null;
  readonly isMember: boolean;
  /** The caller may join: a reader of the running order who is not a Client. */
  readonly canJoin: boolean;
  /** The caller may open it: no channel yet and show.run_of_show.write. */
  readonly canOpen: boolean;
}

/** The panel's state for the signed-in member (app.show_channel_status). */
export async function showChannelStatus(
  db: XosClient,
  projectId: string,
): Promise<Result<ShowChannelStatus>> {
  const { data, error } = await untyped(db).rpc("show_channel_status", { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : data) as {
    channel_exists: boolean;
    conversation_id: string | null;
    am_member: boolean;
    can_join: boolean;
    can_open: boolean;
  } | null;
  if (!row) return fail({ kind: "not-found" });
  return ok({
    exists: row.channel_exists === true,
    conversationId: row.conversation_id,
    isMember: row.am_member === true,
    canJoin: row.can_join === true,
    canOpen: row.can_open === true,
  });
}

/** Opens the project's show channel, or answers the live one (app.open_show_channel). Returns its conversation. */
export async function openShowChannel(
  db: XosClient,
  projectId: string,
): Promise<Result<{ conversationId: string }>> {
  const { data, error } = await untyped(db).rpc("open_show_channel", { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  return ok({ conversationId: String(data) });
}

/** Joins the project's show channel (app.join_show_channel). Returns its conversation. */
export async function joinShowChannel(
  db: XosClient,
  projectId: string,
): Promise<Result<{ conversationId: string }>> {
  const { data, error } = await untyped(db).rpc("join_show_channel", { p_project_id: projectId });
  if (error) return fail(toDataError(error));
  return ok({ conversationId: String(data) });
}

/** Messages newer than the member's read position, from app.my_conversations (never a Client's). */
export async function unreadInConversation(
  db: XosClient,
  orgId: string,
  conversationId: string,
): Promise<Result<number>> {
  const { data, error } = await untyped(db).rpc("my_conversations", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  const row = ((data ?? []) as { conversation_id: string; unread_count: number }[]).find(
    (r) => r.conversation_id === conversationId,
  );
  return ok(row?.unread_count ?? 0);
}
