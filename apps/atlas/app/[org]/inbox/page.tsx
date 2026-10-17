import { isActionableApproval, listInbox, type InboxItem } from "@xos/data/inbox";
import { getTranslations } from "next-intl/server";
import { InboxView, type InboxRow } from "@/components/inbox/inbox-view";
import { ErrorPanel } from "@/components/platform/kit";
import { PageHeader, TemplateCollection } from "@/components/platform/ui";
import { requireNode } from "@/components/shell/sitemap-page";
import { getFormatters } from "@/lib/platform/format";

/** Notification kinds whose email catalog copy needs only a title, an actor and a decision. */
const SIMPLE_KINDS = new Set([
  "mention.created",
  "assignment.created",
  "approval.requested",
  "approval.decided",
  "comment.created",
  "invoice.approved",
  "incident.reported",
  "report.delivered",
  "import.finished",
  "export.ready",
]);

/**
 * Inbox (Section 4.5.2, Section 11.10 rule 5): what needs the viewer (approvals, mentions, assignments)
 * above what is for their information. Each item is approved (A), rejected with a reason (R), marked
 * Done (E) or snoozed (H) right here, without opening the record; J and K move between items.
 */
export default async function Page({ params }: PageProps<"/[org]/inbox">) {
  const ctx = await requireNode("inbox", await params);
  const { t, money, dateTime } = await getFormatters(ctx);
  const email = (await getTranslations("email")) as unknown as ((
    k: string,
    v?: Record<string, string>,
  ) => string) & {
    has: (k: string) => boolean;
  };
  const title = t("inbox.title");
  const result = await listInbox(ctx.viewer.db, ctx.org.id);
  if (!result.ok) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <ErrorPanel sentence={t("inbox.loadError")} />
      </TemplateCollection>
    );
  }
  const describe = (item: InboxItem): { summary: string; detail: string } => {
    const args = {
      title: item.args["title"] ?? t("inbox.aRecord"),
      actorName: item.args["actorName"] ?? t("inbox.someone"),
      decision: item.args["decision"] ?? "approved",
    };
    if (item.approval && item.kind === "approval.requested") {
      return {
        summary: t("inbox.approvalSummary", {
          document: t(`inbox.documents.${item.approval.documentType.replaceAll(" ", "")}`),
          reference: item.approval.reference ?? "",
          amount: money(item.approval.amountMinor, item.approval.currency ?? "USD"),
        }),
        detail: t("inbox.approvalDetail", {
          actor: args.actorName,
          step: item.approval.currentStep,
        }),
      };
    }
    const key = `kinds.${item.kind}`;
    if (SIMPLE_KINDS.has(item.kind) && email.has(`${key}.subject`)) {
      return { summary: email(`${key}.subject`, args), detail: email(`${key}.body`, args) };
    }
    return { summary: t("inbox.generic"), detail: item.kind };
  };
  const rows: InboxRow[] = result.data.map((item) => {
    const text = describe(item);
    return {
      id: item.id,
      section: item.section,
      kind: item.kind,
      unread: !item.read,
      summary: text.summary,
      detail: text.detail,
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
