import type { XosClient } from "./client.ts";
import { ok, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";
import {
  args,
  bool,
  call,
  callId,
  callRows,
  memberName,
  MEMBER_EMBED,
  num,
  numOrNull,
  rows,
  single,
  str,
  strings,
  strOrNull,
  type Raw,
} from "./workforce-shared.ts";
import type { Database } from "./database.types.ts";
import * as enums from "./enums.generated.ts";

/**
 * Group spaces, chat and the directory (Section 4.9 Groups, Chat and Directory; migrations 0800 and
 * 1010), imported as `@xos/data/workforce-chat`. Groups are managed by org.communication.write and
 * their owners; every group has one conversation. Messages are sent through app.send_chat_message
 * (offline sends replay through app.apply_sync_mutation); photos, files and voice notes are
 * attachments on the message. Read receipts show only while the org has them on.
 */

export type GroupKind = Database["app"]["Enums"]["group_kind"];
export type GroupRole = Database["app"]["Enums"]["group_role"];
export type ConversationKind = Database["app"]["Enums"]["conversation_kind"];
export type ChatMessageKind = Database["app"]["Enums"]["chat_message_kind"];

export const GROUP_KINDS: readonly GroupKind[] = enums.groupKind;
export const CHAT_MESSAGE_KINDS: readonly ChatMessageKind[] = enums.chatMessageKind;

export interface Group {
  readonly id: string;
  readonly name: string;
  readonly kind: GroupKind;
  readonly projectId: string | null;
  readonly description: string | null;
  readonly archivedAt: string | null;
  readonly memberCount: number;
  readonly createdAt: string;
}

export interface GroupMember {
  readonly id: string;
  readonly membershipId: string;
  readonly personId: string | null;
  readonly name: string | null;
  readonly role: GroupRole;
}

function toGroup(r: Raw): Group {
  const members = Array.isArray(r["group_members"])
    ? (r["group_members"] as Raw[]).filter((m) => m["deleted_at"] === null).length
    : 0;
  return {
    id: str(r["id"]),
    name: str(r["name"]),
    kind: str(r["group_kind"]) as GroupKind,
    projectId: strOrNull(r["project_id"]),
    description: strOrNull(r["description"]),
    archivedAt: strOrNull(r["archived_at"]),
    memberCount: members,
    createdAt: str(r["created_at"]),
  };
}

/** Groups the viewer reads (their own, or every group for communication admins), by name. */
export async function listGroups(db: XosClient, orgId: string): Promise<Result<Group[]>> {
  return rows(
    untyped(db)
      .from("groups")
      .select(
        "id, name, group_kind, project_id, description, archived_at, created_at, group_members(deleted_at)",
      )
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("name"),
    toGroup,
  );
}

/** The members of a group, owners first. */
export async function listGroupMembers(
  db: XosClient,
  groupId: string,
): Promise<Result<GroupMember[]>> {
  const result = await rows(
    untyped(db)
      .from("group_members")
      .select(`id, membership_id, group_role, membership:memberships(${MEMBER_EMBED})`)
      .eq("group_id", groupId)
      .is("deleted_at", null),
    (r): GroupMember => {
      const m = r["membership"] as Raw | null;
      return {
        id: str(r["id"]),
        membershipId: str(r["membership_id"]),
        personId: strOrNull(m?.["person_id"]),
        name: memberName(m),
        role: str(r["group_role"]) as GroupRole,
      };
    },
  );
  if (!result.ok) return result;
  return ok(
    [...result.data].sort(
      (a, b) =>
        (a.role === "Owner" ? 0 : 1) - (b.role === "Owner" ? 0 : 1) ||
        (a.name ?? "").localeCompare(b.name ?? ""),
    ),
  );
}

export interface GroupInput {
  readonly name: string;
  readonly kind: GroupKind;
  readonly projectId?: string | null;
  readonly description?: string | null;
}

/** Creates a group (org.communication.write); its conversation opens with it. */
export async function createGroup(
  db: XosClient,
  orgId: string,
  input: GroupInput,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("groups")
      .insert({
        org_id: orgId,
        name: input.name,
        group_kind: input.kind,
        project_id: input.projectId ?? null,
        description: input.description ?? null,
      })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

/** Renames a group or edits its description. */
export async function updateGroup(
  db: XosClient,
  groupId: string,
  input: { readonly name: string; readonly description: string | null },
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("groups")
      .update({ name: input.name, description: input.description })
      .eq("id", groupId)
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

/** Archives a group: it keeps its history and takes no new messages. */
export async function archiveGroup(
  db: XosClient,
  groupId: string,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("groups")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", groupId)
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

/** Adds a member to a group (a communication admin or a group owner). */
export async function addGroupMember(
  db: XosClient,
  groupId: string,
  membershipId: string,
  role: GroupRole = "Member",
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("group_members")
      .insert({ group_id: groupId, membership_id: membershipId, group_role: role })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

/** Removes a member from a group; they also leave its conversation. */
export async function removeGroupMember(
  db: XosClient,
  groupMemberId: string,
): Promise<Result<{ id: string }>> {
  return single(
    untyped(db)
      .from("group_members")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", groupMemberId)
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

// Conversations ----------------------------------------------------------------------------------

export interface ConversationSummary {
  readonly id: string;
  readonly kind: ConversationKind;
  readonly groupId: string | null;
  readonly title: string;
  readonly otherMembershipId: string | null;
  readonly lastMessageAt: string | null;
  readonly lastMessageBody: string | null;
  readonly unread: number;
  readonly muted: boolean;
}

/** The viewer's conversations in an org, newest activity first, with unread counts. */
export async function listMyConversations(
  db: XosClient,
  orgId: string,
): Promise<Result<ConversationSummary[]>> {
  return callRows(db, "my_conversations", { p_org_id: orgId }, (r) => ({
    id: str(r["conversation_id"]),
    kind: str(r["conversation_kind"]) as ConversationKind,
    groupId: strOrNull(r["group_id"]),
    title: str(r["title"]),
    otherMembershipId: strOrNull(r["other_membership_id"]),
    lastMessageAt: strOrNull(r["last_message_at"]),
    lastMessageBody: strOrNull(r["last_message_body"]),
    unread: num(r["unread_count"]),
    muted: bool(r["muted"]),
  }));
}

/** Opens, or finds, the one-to-one conversation with another member. */
export async function startDirectConversation(
  db: XosClient,
  orgId: string,
  otherMembershipId: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "start_direct_conversation", {
    p_org_id: orgId,
    p_other_membership_id: otherMembershipId,
  });
}

export interface ChatMessage {
  readonly id: string;
  readonly authorMembershipId: string;
  readonly authorName: string | null;
  readonly kind: ChatMessageKind;
  readonly body: string | null;
  readonly language: string | null;
  readonly createdAt: string;
  readonly editedAt: string | null;
}

/** The newest messages of a conversation, oldest first for display. */
export async function listMessages(
  db: XosClient,
  conversationId: string,
  limit = 100,
): Promise<Result<ChatMessage[]>> {
  const result = await rows(
    untyped(db)
      .from("chat_messages")
      .select(
        `id, author_membership_id, message_kind, body, language, created_at, edited_at, author:memberships(${MEMBER_EMBED})`,
      )
      .eq("conversation_id", conversationId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(limit),
    (r): ChatMessage => ({
      id: str(r["id"]),
      authorMembershipId: str(r["author_membership_id"]),
      authorName: memberName(r["author"]),
      kind: str(r["message_kind"]) as ChatMessageKind,
      body: strOrNull(r["body"]),
      language: strOrNull(r["language"]),
      createdAt: str(r["created_at"]),
      editedAt: strOrNull(r["edited_at"]),
    }),
  );
  return result.ok ? ok([...result.data].reverse()) : result;
}

/** Sends a message; the other members are notified. */
export async function sendMessage(
  db: XosClient,
  conversationId: string,
  input: {
    readonly body: string | null;
    readonly kind?: ChatMessageKind;
    readonly language?: string;
  },
): Promise<Result<{ id: string }>> {
  return callId(
    db,
    "send_chat_message",
    args({
      p_conversation_id: conversationId,
      p_body: input.body,
      p_message_kind: input.kind,
      p_language: input.language,
    }),
  );
}

/** The author edits their message text. */
export async function editMessage(
  db: XosClient,
  messageId: string,
  body: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "edit_chat_message", { p_message_id: messageId, p_body: body });
}

/** The author deletes their message. */
export async function deleteMessage(
  db: XosClient,
  messageId: string,
): Promise<Result<{ id: string }>> {
  return callId(db, "delete_chat_message", { p_message_id: messageId });
}

/** Marks a conversation read up to now, optionally muting or unmuting it. */
export async function markConversationRead(
  db: XosClient,
  conversationId: string,
  muted?: boolean,
): Promise<Result<string>> {
  return call<string>(
    db,
    "mark_conversation_read",
    args({ p_conversation_id: conversationId, p_muted: muted }),
  );
}

export interface ReadReceipt {
  readonly membershipId: string;
  readonly name: string;
  readonly lastReadAt: string | null;
}

/** Who has read a conversation; empty while the org has read receipts off. */
export async function listReadReceipts(
  db: XosClient,
  conversationId: string,
): Promise<Result<ReadReceipt[]>> {
  return callRows(db, "conversation_read_receipts", { p_conversation_id: conversationId }, (r) => ({
    membershipId: str(r["membership_id"]),
    name: str(r["full_name"]),
    lastReadAt: strOrNull(r["last_read_at"]),
  }));
}

/** Whether a message was read by someone, from the receipts. */
export function readBy(
  message: Pick<ChatMessage, "createdAt">,
  receipts: readonly ReadReceipt[],
): string[] {
  return receipts
    .filter((r) => r.lastReadAt !== null && r.lastReadAt >= message.createdAt)
    .map((r) => r.name);
}

// Directory ---------------------------------------------------------------------------------------

export interface DirectoryPerson {
  readonly membershipId: string;
  readonly personId: string;
  readonly name: string;
  readonly preferredName: string | null;
  readonly headline: string | null;
  readonly photoPath: string | null;
  readonly roles: readonly string[];
  readonly onSite: boolean;
  readonly onSiteProjectId: string | null;
  readonly onSiteSince: string | null;
  readonly workPhone: string | null;
  readonly recognitionCount: number | null;
}

/** The org directory: on-site members first, searchable, optionally only those on site now. */
export async function listWorkforceDirectory(
  db: XosClient,
  orgId: string,
  options: { readonly search?: string | null; readonly onSiteOnly?: boolean } = {},
): Promise<Result<DirectoryPerson[]>> {
  return callRows(
    db,
    "workforce_directory",
    args({
      p_org_id: orgId,
      p_search: options.search ?? undefined,
      p_on_site_only: options.onSiteOnly,
    }),
    (r) => ({
      membershipId: str(r["membership_id"]),
      personId: str(r["person_id"]),
      name: str(r["full_name"]),
      preferredName: strOrNull(r["preferred_name"]),
      headline: strOrNull(r["headline"]),
      photoPath: strOrNull(r["photo_path"]),
      roles: strings(r["role_names"]),
      onSite: bool(r["on_site_now"]),
      onSiteProjectId: strOrNull(r["on_site_project_id"]),
      onSiteSince: strOrNull(r["on_site_since"]),
      workPhone: strOrNull(r["work_phone"]),
      recognitionCount: numOrNull(r["recognition_count"]),
    }),
  );
}

/** A tel: link for a work phone, keeping only digits and a leading plus; null when unusable. */
export function telHref(phone: string | null): string | null {
  if (phone === null) return null;
  const digits = phone.replace(/[^0-9+]/g, "").replace(/(?!^)\+/g, "");
  return digits.replace(/\+/g, "").length >= 3 ? `tel:${digits}` : null;
}
