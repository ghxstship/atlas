import type { XosClient } from "./client.ts";
import { derivedRow, external, req } from "./gateway-external.ts";
import { toDisplayKey } from "./gateway-keys.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Party conversations (A28b 0773, Section 4.5.8 Messages: per engagement and per org): threads
 * between an org and an external person or account outside any one engagement, with unread
 * counts and read receipts. Engagement threads live in gateway.ts; Messages shows both.
 */

export interface PartyThread {
  readonly id: string;
  readonly key: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly subject: string;
  readonly createdAt: string;
  readonly lastMessageAt: string | null;
  readonly unread: number;
}

export interface PartyMessage {
  readonly id: string;
  readonly threadId: string;
  readonly authorPersonId: string | null;
  readonly authorName: string | null;
  readonly body: string;
  readonly sentAt: string;
}

export interface ReadReceipt {
  readonly personId: string;
  readonly personName: string | null;
  readonly lastReadAt: string;
}

/** The caller's party threads, most recent activity first. */
export async function listPartyThreads(db: XosClient): Promise<Result<PartyThread[]>> {
  const { data, error } = await external(db)
    .from("party_threads")
    .select("id, org_id, org_name, subject, created_at, last_message_at, unread_count")
    .order("last_message_at", { ascending: false, nullsFirst: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => {
      const id = req(row.id, "party_threads.id");
      return {
        id,
        key: toDisplayKey("thread", id),
        orgId: req(row.org_id, "party_threads.org_id"),
        orgName: req(row.org_name, "party_threads.org_name"),
        subject: req(row.subject, "party_threads.subject"),
        createdAt: req(row.created_at, "party_threads.created_at"),
        lastMessageAt: row.last_message_at,
        unread: row.unread_count ?? 0,
      };
    }),
  );
}

/** Messages of one party thread, oldest first. */
export async function listPartyMessages(
  db: XosClient,
  threadId: string,
): Promise<Result<PartyMessage[]>> {
  const { data, error } = await external(db)
    .from("party_messages")
    .select("id, party_thread_id, author_person_id, author_name, body, sent_at")
    .eq("party_thread_id", threadId)
    .order("sent_at", { ascending: true });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: req(row.id, "party_messages.id"),
      threadId: req(row.party_thread_id, "party_messages.party_thread_id"),
      authorPersonId: row.author_person_id,
      authorName: row.author_name,
      body: req(row.body, "party_messages.body"),
      sentAt: req(row.sent_at, "party_messages.sent_at"),
    })),
  );
}

/** Starts a conversation with an org as oneself or for an account (app.start_party_thread). */
export async function startPartyThread(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly subject: string;
    readonly body: string;
    readonly personId: string | null;
    readonly accountId: string | null;
  },
): Promise<Result<{ threadId: string }>> {
  const { data, error } = await db.rpc("start_party_thread", {
    p_org_id: input.orgId,
    p_subject: input.subject.trim(),
    p_body: input.body.trim(),
    // The RPC takes NULL for the side that does not apply; the generated type omits null.
    p_party_person_id: input.personId as string,
    p_party_organization_id: input.accountId as string,
  });
  if (error) return fail(toDataError(error));
  return ok({ threadId: data });
}

/** Posts to a party thread; the author and time are stamped by the database. */
export async function sendPartyMessage(
  db: XosClient,
  input: { readonly threadId: string; readonly body: string },
): Promise<Result<null>> {
  const { error } = await db
    .from("party_messages")
    .insert(
      derivedRow<"party_messages">({ party_thread_id: input.threadId, body: input.body.trim() }),
    );
  return error ? fail(toDataError(error)) : ok(null);
}

/** Marks an engagement or party thread read up to now (app.mark_thread_read). */
export async function markThreadRead(
  db: XosClient,
  thread: { readonly engagementThreadId: string } | { readonly partyThreadId: string },
): Promise<Result<null>> {
  const { error } = await db.rpc("mark_thread_read", {
    p_engagement_thread_id: ("engagementThreadId" in thread
      ? thread.engagementThreadId
      : null) as string,
    p_party_thread_id: ("partyThreadId" in thread ? thread.partyThreadId : null) as string,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Who has read a thread, and up to when (optional read receipts, Section 11.12). */
export async function listReadReceipts(
  db: XosClient,
  thread: { readonly engagementThreadId: string } | { readonly partyThreadId: string },
): Promise<Result<ReadReceipt[]>> {
  const column = "engagementThreadId" in thread ? "engagement_thread_id" : "party_thread_id";
  const value = "engagementThreadId" in thread ? thread.engagementThreadId : thread.partyThreadId;
  const { data, error } = await external(db)
    .from("thread_read_receipts")
    .select("person_id, person_name, last_read_at")
    .eq(column, value);
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      personId: req(row.person_id, "thread_read_receipts.person_id"),
      personName: row.person_name,
      lastReadAt: req(row.last_read_at, "thread_read_receipts.last_read_at"),
    })),
  );
}
