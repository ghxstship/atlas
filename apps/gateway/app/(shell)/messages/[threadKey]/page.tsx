import {
  fromDisplayKey,
  getThread,
  listMessages,
  listPartyMessages,
  listReadReceipts,
  type Message,
  type PartyMessage,
} from "@xos/data/gateway";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale } from "next-intl/server";
import { MessageComposer } from "@/components/engagement/forms";
import { MarkRead } from "@/components/messages/client";
import { ConversationList } from "@/components/messages/conversation-list";
import { PageTitle, RegionError } from "@/components/page/page";
import { inBrandScope } from "@/lib/brand/brand";
import { loadConversations } from "@/lib/conversations";
import { formatDateTime } from "@/lib/format";
import { requireNode } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("nav.gateway.messages.thread") };
}

/**
 * One conversation (Section 4.5.8, Section 11.12 Communicate): the messages, who has read up to
 * when, and the composer. A thread the person may not see answers 404, like one that does not
 * exist.
 */
export default async function ThreadPage({ params }: PageProps<"/messages/[threadKey]">) {
  const { threadKey } = await params;
  const ctx = await requireNode("messages.thread", { threadKey });
  const id = fromDisplayKey("thread", threadKey);
  if (!id) notFound();
  const [t, locale, loaded] = await Promise.all([getTranslate(), getLocale(), loadConversations(ctx.db)]);
  if (!loaded) return <RegionError />;
  const conversation = loaded.conversations.find((c) => c.id === id);
  if (!conversation || !inBrandScope(ctx.brand, conversation.orgId)) notFound();
  const [messages, receipts] = await Promise.all([
    conversation.kind === "engagement" ? listMessages(ctx.db, [id]) : listPartyMessages(ctx.db, id),
    listReadReceipts(ctx.db, conversation.kind === "engagement" ? { engagementThreadId: id } : { partyThreadId: id }),
  ]);
  const engagementThread = conversation.kind === "engagement" ? await getThread(ctx.db, id) : null;
  const engagement = engagementThread?.ok ? loaded.engagements.find((e) => e.id === engagementThread.data.engagementId) : undefined;
  const others = receipts.ok ? receipts.data.filter((r) => r.personId !== ctx.personId) : [];
  const list: readonly (Message | PartyMessage)[] = messages.ok ? messages.data : [];
  return (
    <div className="grid grid-cols-[minmax(0,var(--layout-sidebar-max))_minmax(0,1fr)] gap-16 max-md:grid-cols-[minmax(0,1fr)]">
      <div className="max-md:hidden">
        <ConversationList conversations={loaded.conversations.filter((c) => inBrandScope(ctx.brand, c.orgId))} activeKey={threadKey} locale={locale} t={t} />
      </div>
      <div className="flex min-w-0 flex-col gap-16">
        <Link href={"/messages" as Route} className="text-text-13 text-text-secondary underline md:hidden">
          {t("nav.gateway.primary.messages")}
        </Link>
        <PageTitle
          title={conversation.subject}
          eyebrow={conversation.orgName}
          lead={
            engagement ? (
              <Link href={`/work/engagements/${engagement.key}/overview` as Route} className="text-accent-text underline">
                {conversation.context}
              </Link>
            ) : (
              t("gateway.messages.withOrg")
            )
          }
        />
        <MarkRead kind={conversation.kind} threadId={id} />
        {!messages.ok ? (
          <RegionError />
        ) : (
          <ol aria-label={t("gateway.messages.history")} className="m-0 flex list-none flex-col gap-12 p-0">
            {list.map((m) => (
              <li
                key={m.id}
                className={`flex max-w-layout-reading flex-col gap-2 rounded-card p-12 ${m.authorPersonId === ctx.personId ? "self-end bg-bg-hover" : "self-start border border-border-subtle bg-bg-raised"}`}
              >
                <span className="text-text-12 text-text-secondary">
                  {m.authorPersonId === ctx.personId ? t("gateway.messages.you") : (m.authorName ?? t("gateway.engagement.messages.org"))} ·{" "}
                  {formatDateTime(locale, m.sentAt)}
                </span>
                <span className="whitespace-pre-line text-text-14">{m.body}</span>
              </li>
            ))}
          </ol>
        )}
        {others.length > 0 ? (
          <p className="m-0 text-text-12 text-text-secondary">
            {t("gateway.messages.readBy", {
              list: others.map((r) => `${r.personName ?? ""} ${formatDateTime(locale, r.lastReadAt)}`).join(", "),
            })}
          </p>
        ) : null}
        <MessageComposer threadId={id} action={conversation.kind} />
      </div>
    </div>
  );
}
