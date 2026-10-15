import { getNode } from "@xos/ia";
import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { ConversationList } from "@/components/messages/conversation-list";
import { StartConversationForm } from "@/components/messages/client";
import { PageTitle, pickView, RegionError, Section, ViewSwitcher } from "@/components/page/page";
import { EmptyStateLink } from "@/components/ui";
import { inBrandScope } from "@/lib/brand/brand";
import { loadConversations } from "@/lib/conversations";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("nav.gateway.primary.messages") };
}

/**
 * Messages (Section 4.5.8): every conversation per engagement and per org. On a wide screen the
 * split view keeps the list beside the open thread; on a phone the list opens each thread full
 * screen.
 */
export default async function MessagesPage({ searchParams }: PageProps<"/messages">) {
  const ctx = await requireNode("messages");
  const query = await searchParams;
  const views = getNode(sitemap, "messages").node.list?.views ?? ["split"];
  const view = pickView(query["view"], views, "split");
  const [t, locale, loaded] = await Promise.all([
    getTranslate(),
    getLocale(),
    loadConversations(ctx.db),
  ]);
  const orgs = new Map<string, string>();
  for (const e of loaded?.engagements ?? [])
    if (inBrandScope(ctx.brand, e.orgId)) orgs.set(e.orgId, e.orgName);
  const conversations = (loaded?.conversations ?? []).filter((c) =>
    inBrandScope(ctx.brand, c.orgId),
  );
  return (
    <>
      <PageTitle
        title={t("nav.gateway.primary.messages")}
        action={<ViewSwitcher views={views} current={view} path="/messages" query={query} />}
      />
      {!loaded ? (
        <RegionError />
      ) : conversations.length === 0 ? (
        <EmptyStateLink
          icon="MessagesSquare"
          sentence={t("gateway.messages.empty")}
          actionLabel={t("gateway.messages.emptyAction")}
          href="/work/engagements"
        />
      ) : (
        <div
          className={
            view === "split"
              ? "grid grid-cols-[minmax(0,var(--layout-sidebar-max))_minmax(0,1fr)] gap-16 max-md:grid-cols-[minmax(0,1fr)]"
              : "flex flex-col gap-16"
          }
        >
          <ConversationList conversations={conversations} locale={locale} t={t} />
          {view === "split" ? (
            <p className="m-0 self-center text-center text-text-14 text-text-secondary max-md:hidden">
              {t("gateway.messages.pick")}
            </p>
          ) : null}
        </div>
      )}
      <Section title={t("gateway.messages.start.title")}>
        <StartConversationForm orgs={[...orgs].map(([id, name]) => ({ id, name }))} />
      </Section>
    </>
  );
}
