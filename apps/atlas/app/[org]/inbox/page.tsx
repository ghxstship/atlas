import { isActionableApproval, listInbox } from "@xos/data/inbox";
import { personNames } from "@xos/data/person-names";
import { getMyNotificationTimeZone } from "@xos/data/notification-settings";
import { inboxItemInLens } from "@xos/data/role-lens";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { InboxView, type InboxRow } from "@/components/inbox/inbox-view";
import { ErrorPanel } from "@/components/platform/kit";
import { PageHeader, TemplateCollection } from "@/components/platform/client/page-header";
import { describeInboxItem, type InboxCopy } from "@/lib/inbox/describe";
import { emailCopy } from "@/lib/inbox/email-copy";
import { requireNode } from "@/lib/shell/require-node";
import { getFormatters } from "@/lib/platform/format";
import { getOrgTimeZone } from "@/lib/shell/time-zone";

type Translator = ((key: string, values?: Record<string, unknown>) => string) & {
  has: (key: string) => boolean;
};

/**
 * Inbox (Section 4.5.2, Section 11.10 rule 5): what needs the viewer (approvals, mentions, assignments)
 * above what is for their information. Each item reads as a human title and summary (A59-006) and
 * opens where it belongs; it is approved (A), rejected with a reason (R), marked Done (E) or snoozed
 * (H) right here, without opening the record; J and K move between items. Under a role lens (A128) it lists what
 * is addressed to the viewer and what the lens role's capabilities brought them, never another role's items. Email copy
 * is formatted with its named date and time styles, in the time zone the member's email is sent in, or the org's
 * (lib/inbox/email-copy.ts).
 */
export default async function Page({ params }: PageProps<"/[org]/inbox">) {
  const ctx = await requireNode("inbox", await params);
  const [{ t, money, dateTime }, locale, messages, zone] = await Promise.all([
    getFormatters(ctx),
    getLocale(),
    getMessages(),
    getMyNotificationTimeZone(ctx.viewer.db, ctx.org.id),
  ]);
  const email = (await getTranslations("email")) as unknown as Translator;
  const timeZone = (zone.ok ? zone.data : null) ?? (await getOrgTimeZone(ctx));
  const styled = emailCopy((messages as Record<string, unknown>)["email"], locale, timeZone);
  const platform = (await getTranslations("platform")) as unknown as Translator;
  const title = t("inbox.title");
  const result = await listInbox(ctx.viewer.db, ctx.org.id);
  if (!result.ok) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <ErrorPanel sentence={t("inbox.loadError")} />
      </TemplateCollection>
    );
  }
  const items = result.data.filter((item) =>
    inboxItemInLens(
      {
        kind: item.kind,
        subjectTable: item.subjectTable,
        approverRoleId: item.approval?.approverRoleId ?? null,
      },
      ctx.lens.inbox,
    ),
  );
  // Who acted, for notifications that did not store the actor's name (one name resolution, A59-011).
  const actors = await personNames(
    ctx.viewer.db,
    items.filter((item) => !item.args["actorName"]).map((item) => item.actorPersonId),
  );
  const copy: InboxCopy = {
    t,
    email: (key, values) => styled(key, values) ?? email(key, values),
    hasEmail: (key) => email.has(key),
    hasPlatform: (key) => platform.has(key),
    money,
  };
  const rows: InboxRow[] = items.map((item) => {
    const text = describeInboxItem(item, copy, {
      org: ctx.org.slug,
      orgName: ctx.org.name,
      actorName: item.actorPersonId ? (actors.get(item.actorPersonId) ?? null) : null,
    });
    return {
      id: item.id,
      section: item.section,
      kind: item.kind,
      unread: !item.read,
      summary: text.summary,
      detail: text.detail,
      href: text.href,
      when: dateTime(item.createdAt),
      approvable: isActionableApproval(item),
    };
  });
  const needsYou = rows.filter((r) => r.section === "Needs You").length;
  return (
    <TemplateCollection header={<PageHeader title={title} count={needsYou} />}>
      <InboxView org={ctx.org.slug} rows={rows} />
    </TemplateCollection>
  );
}
