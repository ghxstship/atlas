import {
  listMessages,
  listMyConversations,
  listReadReceipts,
  listWorkforceDirectory,
  readBy,
  telHref,
  type ConversationSummary,
} from "@xos/data/workforce-chat";
import { getFormatter } from "next-intl/server";
import { ActionButton, EntityForm, ErrorPanel, KitLink } from "@/components/collection-kit/kit";
import { InlineAlert, PageHeader } from "@/components/collection-kit/ui";
import { EmptyStateLink } from "@/components/ui";
import {
  deleteMessageAction,
  markReadAction,
  sendMessageAction,
  startConversationAction,
} from "@/lib/workforce/actions";
import type { SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { TemplateSplitView } from "./client";
import { REFUSALS, workforceCopy } from "./shared";
import { CollectionPage } from "@/components/platform/collection-page";

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * People > Chat (Section 4.9 Chat and Directory): the member's one-to-one and group conversations
 * beside the open thread, newest activity first with unread counts. The directory finds anyone in the
 * org, shows who is on site now and offers one-tap message or call. Read receipts show only when the
 * org turns them on; photos, files and voice notes from Compass arrive as attachments.
 */
export async function ChatSection({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const db = ctx.viewer.db;
  const open = first(search["c"]);
  const query = first(search["q"]) ?? "";
  const onSite = first(search["site"]) === "1";
  const [t, format, conversations, directory] = await Promise.all([
    workforceCopy(),
    getFormatter(),
    listMyConversations(db, ctx.org.id),
    listWorkforceDirectory(db, ctx.org.id, {
      search: query === "" ? null : query,
      onSiteOnly: onSite,
    }),
  ]);
  const title = t("chat.title");
  if (!conversations.ok) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <ErrorPanel what={t("chat.what")} />
      </CollectionPage>
    );
  }
  const when = (d: string) =>
    format.dateTime(new Date(d), { dateStyle: "short", timeStyle: "short" });
  const current = open ? conversations.data.find((c) => c.id === open) : undefined;
  const href = (c: ConversationSummary) => `${path}?c=${c.id}`;

  const list = (
    <nav aria-label={t("chat.conversations")} className="flex flex-col gap-4">
      {conversations.data.length === 0 ? (
        <EmptyStateLink
          icon="MessagesSquare"
          sentence={t("chat.empty")}
          actionLabel={t("chat.emptyAction")}
          href="#directory-q"
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {conversations.data.map((c) => (
            <li key={c.id}>
              <a
                href={href(c)}
                aria-current={c.id === open ? "page" : undefined}
                className={`flex flex-col gap-2 rounded-control px-8 py-6 text-text-13 no-underline hover:bg-bg-hover focus-visible:outline-(length:--stroke-width-focus) focus-visible:outline-focus-ring ${c.id === open ? "bg-bg-selected" : ""}`}
              >
                <span className="flex items-center justify-between gap-8">
                  <strong className="font-medium text-text-primary">
                    {c.title || t("chat.untitled")}
                  </strong>
                  {c.unread > 0 ? (
                    <span className="text-text-12 font-semibold text-accent-text">
                      {t("chat.unread", { count: c.unread })}
                    </span>
                  ) : null}
                </span>
                <TruncatedLine
                  text={`${c.lastMessageBody ?? t("chat.noMessages")}${c.lastMessageAt ? ` · ${when(c.lastMessageAt)}` : ""}`}
                />
              </a>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );

  let detail;
  if (current) {
    const [messages, receipts] = await Promise.all([
      listMessages(db, current.id),
      listReadReceipts(db, current.id),
    ]);
    detail = (
      <section aria-labelledby="chat-thread-title" className="flex min-w-0 flex-col gap-12">
        <header className="flex flex-wrap items-center justify-between gap-8">
          <h2 id="chat-thread-title" className="m-0 text-text-16 font-semibold">
            {current.title || t("chat.untitled")}
          </h2>
          <div className="flex flex-wrap gap-8">
            {current.unread > 0 ? (
              <ActionButton
                action={markReadAction}
                hidden={{ org: ctx.org.slug, id: current.id }}
                label={t("chat.markRead")}
                refusals={REFUSALS}
              />
            ) : null}
            <ActionButton
              action={markReadAction}
              hidden={{
                org: ctx.org.slug,
                id: current.id,
                muted: current.muted ? "false" : "true",
              }}
              label={current.muted ? t("chat.unmute") : t("chat.mute")}
              refusals={REFUSALS}
            />
          </div>
        </header>
        {!messages.ok ? (
          <ErrorPanel what={t("chat.messages")} />
        ) : messages.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("chat.startThread")}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-8 p-0" aria-label={t("chat.messages")}>
            {messages.data.map((m) => {
              const mine = m.authorMembershipId === ctx.org.membershipId;
              const seen = mine && receipts.ok ? readBy(m, receipts.data) : [];
              return (
                <li
                  key={m.id}
                  className={`flex flex-col gap-2 rounded-card border border-border-subtle p-8 text-text-13 ${mine ? "self-end bg-bg-subtle" : ""}`}
                >
                  <span className="text-text-12 text-text-secondary">
                    {mine ? t("chat.you") : (m.authorName ?? t("someone"))} · {when(m.createdAt)}
                    {m.editedAt ? ` · ${t("chat.edited")}` : ""}
                  </span>
                  <span className="whitespace-pre-wrap">{m.body ?? t(`chat.kinds.${m.kind}`)}</span>
                  {seen.length > 0 ? (
                    <span className="text-text-11 text-text-tertiary">
                      {t("chat.seenBy", { names: seen.join(", ") })}
                    </span>
                  ) : null}
                  {mine ? (
                    <ActionButton
                      action={deleteMessageAction}
                      hidden={{ org: ctx.org.slug, id: m.id }}
                      label={t("chat.delete")}
                      variant="danger"
                      confirm={{ title: t("chat.deleteTitle"), body: t("chat.deleteBody") }}
                      refusals={REFUSALS}
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        <EntityForm
          id={`chat-send-${current.id}`}
          action={sendMessageAction}
          hidden={{ org: ctx.org.slug, id: current.id }}
          refusals={REFUSALS}
          submitLabel={t("chat.send")}
          fields={[
            { kind: "textarea", name: "body", label: t("chat.message"), required: true, rows: 3 },
          ]}
        />
      </section>
    );
  } else {
    detail = (
      <section aria-labelledby="chat-directory-title" className="flex min-w-0 flex-col gap-12">
        <h2 id="chat-directory-title" className="m-0 text-text-16 font-semibold">
          {t("chat.directory")}
        </h2>
        <form method="get" action={path} className="flex flex-wrap items-end gap-8">
          <div className="flex flex-col gap-4">
            <label htmlFor="directory-q" className="text-label-13 font-medium">
              {t("chat.search")}
            </label>
            <input
              id="directory-q"
              name="q"
              type="search"
              defaultValue={query}
              className="h-control-md max-w-full rounded-control border border-border-control bg-bg-surface px-8 text-text-13"
            />
          </div>
          <label className="flex items-center gap-4 text-text-13">
            <input type="checkbox" name="site" value="1" defaultChecked={onSite} />
            {t("chat.onSiteOnly")}
          </label>
          <button
            type="submit"
            className="h-control-md rounded-control border border-border-control bg-bg-surface px-12 text-text-13 font-medium"
          >
            {t("chat.find")}
          </button>
        </form>
        {!directory.ok ? (
          <ErrorPanel what={t("chat.directory")} />
        ) : directory.data.length === 0 ? (
          <InlineAlert tone="info">{t("chat.nobody")}</InlineAlert>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {directory.data.map((p) => {
              const tel = telHref(p.workPhone);
              return (
                <li
                  key={p.membershipId}
                  className="flex flex-wrap items-center justify-between gap-8 rounded-card border border-border-subtle p-8 text-text-13"
                >
                  <span className="flex flex-col gap-2">
                    <strong className="font-medium">{p.preferredName ?? p.name}</strong>
                    <span className="text-text-12 text-text-secondary">
                      {[p.headline, p.roles.join(", "), p.onSite ? t("chat.onSite") : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  {p.membershipId === ctx.org.membershipId ? (
                    <span className="text-text-12 text-text-secondary">{t("chat.you")}</span>
                  ) : (
                    <span className="flex flex-wrap gap-8">
                      <ActionButton
                        action={startConversationAction}
                        hidden={{ org: ctx.org.slug, membershipId: p.membershipId }}
                        label={t("chat.messagePerson", { name: p.preferredName ?? p.name })}
                        variant="secondary"
                        refusals={REFUSALS}
                      />
                      {tel ? (
                        <KitLink href={tel} size="sm">
                          {t("chat.call", { name: p.preferredName ?? p.name })}
                        </KitLink>
                      ) : null}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-16">
      <PageHeader
        title={title}
        actions={
          current ? (
            <KitLink href={path} size="sm">
              {t("chat.newMessage")}
            </KitLink>
          ) : null
        }
      />
      <TemplateSplitView listLabel={t("chat.conversations")} list={list} detail={detail} />
    </div>
  );
}

/** The last message and its time, ellipsized with the whole line as its title. */
function TruncatedLine({ text }: { text: string }) {
  return (
    <span className="truncate text-text-12 text-text-secondary" title={text}>
      {text}
    </span>
  );
}
