import {
  listMyEngagements,
  listPartyThreads,
  listThreads,
  type Engagement,
  type PartyThread,
  type Thread,
  type XosClient,
} from "@xos/data/gateway";

/**
 * Messages (Section 4.5.8: conversations per engagement and per org). Engagement threads and
 * party threads share one list, newest activity first, so a person finds every conversation in
 * one place.
 */
export type Conversation =
  | {
      readonly kind: "engagement";
      readonly key: string;
      readonly id: string;
      readonly subject: string;
      readonly orgId: string;
      readonly orgName: string;
      readonly context: string;
      readonly at: string;
      readonly unread: number;
    }
  | {
      readonly kind: "party";
      readonly key: string;
      readonly id: string;
      readonly subject: string;
      readonly orgId: string;
      readonly orgName: string;
      readonly context: null;
      readonly at: string;
      readonly unread: number;
    };

export function mergeConversations(
  threads: readonly Thread[],
  party: readonly PartyThread[],
  engagements: readonly Engagement[],
): Conversation[] {
  const byId = new Map(engagements.map((e) => [e.id, e]));
  const list: Conversation[] = [
    ...threads.map((t): Conversation => {
      const e = byId.get(t.engagementId);
      return {
        kind: "engagement",
        key: t.key,
        id: t.id,
        subject: t.subject,
        orgId: e?.orgId ?? "",
        orgName: e?.orgName ?? "",
        context: e ? `${e.jobTitle} · ${e.projectName}` : "",
        at: t.createdAt,
        unread: 0,
      };
    }),
    ...party.map(
      (p): Conversation => ({
        kind: "party",
        key: p.key,
        id: p.id,
        subject: p.subject,
        orgId: p.orgId,
        orgName: p.orgName,
        context: null,
        at: p.lastMessageAt ?? p.createdAt,
        unread: p.unread,
      }),
    ),
  ];
  return list.sort((a, b) => b.at.localeCompare(a.at));
}

export async function loadConversations(db: XosClient) {
  const [threads, party, engagements] = await Promise.all([
    listThreads(db),
    listPartyThreads(db),
    listMyEngagements(db),
  ]);
  if (!threads.ok || !party.ok || !engagements.ok) return null;
  return {
    conversations: mergeConversations(threads.data, party.data, engagements.data),
    engagements: engagements.data,
  };
}
