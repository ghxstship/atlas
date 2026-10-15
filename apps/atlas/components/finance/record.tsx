import { listMembers } from "@xos/data";
import { listAttachments } from "@xos/data/attachments";
import { listThreads } from "@xos/data/comments";
import type { Transition } from "@xos/data/finance";
import { cache } from "react";
import type { OrgContext } from "@/lib/shell/context";
import { ActivityTimeline } from "./figures";
import { FinanceAttachments, FinanceComments } from "./collab";

/**
 * The shared lower half of every finance record (Section 11.2 rule 4): the activity built from the
 * document's transition ledger, then comments and attachments.
 */

export const getMemberNames = cache(async (ctx: OrgContext): Promise<Record<string, string>> => {
  const members = await listMembers(ctx.viewer.db, ctx.org.id);
  const names: Record<string, string> = {};
  if (members.ok) for (const m of members.data) if (m.fullName) names[m.personId] = m.fullName;
  return names;
});

export async function RecordActivity({
  ctx,
  transitions,
  stateLabel,
  t,
  format,
}: {
  ctx: OrgContext;
  transitions: readonly Transition[];
  stateLabel: (state: string) => string;
  t: (key: string, values?: Record<string, string | number>) => string;
  format: (iso: string) => string;
}) {
  const names = await getMemberNames(ctx);
  return (
    <ActivityTimeline
      title={t("finance.common.activity")}
      empty={t("finance.common.noActivity")}
      items={[...transitions].reverse().map((tr) => ({
        id: tr.id,
        text: t(tr.fromState ? "finance.common.moved" : "finance.common.createdAs", {
          who: (tr.createdBy && names[tr.createdBy]) || t("finance.common.platform"),
          state: stateLabel(tr.toState),
        }),
        reason: tr.reason,
        when: format(tr.createdAt),
      }))}
    />
  );
}

export async function RecordCollab({
  ctx,
  table,
  id,
  canUpload,
}: {
  ctx: OrgContext;
  table: string;
  id: string;
  canUpload: boolean;
}) {
  const db = ctx.viewer.db;
  const subject = { table, id };
  const [threads, attachments, names] = await Promise.all([
    listThreads(db, subject),
    listAttachments(db, subject),
    getMemberNames(ctx),
  ]);
  if (!threads.ok) throw new Error(`Cannot load comments: ${JSON.stringify(threads.error)}`);
  if (!attachments.ok)
    throw new Error(`Cannot load attachments: ${JSON.stringify(attachments.error)}`);
  return (
    <>
      <FinanceComments
        org={ctx.org.slug}
        subjectTable={table}
        subjectId={id}
        threads={threads.data}
        names={names}
        me={ctx.viewer.person?.id ?? null}
      />
      <FinanceAttachments
        org={ctx.org.slug}
        subjectTable={table}
        subjectId={id}
        attachments={attachments.data}
        canUpload={canUpload}
      />
    </>
  );
}
