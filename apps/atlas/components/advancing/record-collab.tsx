import { listMembers } from "@xos/data";
import { listAttachments } from "@xos/data/attachments";
import { listThreads } from "@xos/data/comments";
import type { AdvancingContext } from "./context";
import { AttachmentsPanel, CommentsPanel } from "./collab";

/**
 * Comments and attachments of one Advancing row. Reading follows the row's read policy in the
 * database: anyone who can read the row may comment (A18), and uploads are offered to people who
 * may change it.
 */
export async function RecordCollab({
  actx,
  table,
  id,
  canUpload,
}: {
  actx: AdvancingContext;
  table: string;
  id: string;
  canUpload: boolean;
}) {
  const db = actx.ctx.viewer.db;
  const subject = { table, id };
  const [threads, attachments, members] = await Promise.all([
    listThreads(db, subject),
    listAttachments(db, subject),
    listMembers(db, actx.ctx.org.id),
  ]);
  if (!threads.ok) throw new Error(`Cannot load comments: ${JSON.stringify(threads.error)}`);
  if (!attachments.ok) {
    throw new Error(`Cannot load attachments: ${JSON.stringify(attachments.error)}`);
  }
  const names: Record<string, string> = {};
  if (members.ok) for (const m of members.data) if (m.fullName) names[m.personId] = m.fullName;
  return (
    <>
      <CommentsPanel
        org={actx.ctx.org.slug}
        subjectTable={table}
        subjectId={id}
        threads={threads.data}
        names={names}
        me={actx.ctx.viewer.person?.id ?? null}
      />
      <AttachmentsPanel
        org={actx.ctx.org.slug}
        subjectTable={table}
        subjectId={id}
        attachments={attachments.data}
        canUpload={canUpload}
      />
    </>
  );
}
