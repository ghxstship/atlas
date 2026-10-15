import { listAttachments } from "@xos/data/attachments";
import { listThreads } from "@xos/data/comments";
import { listMembers } from "@xos/data";
import type { ModulePage } from "@/lib/operations/context";
import { AttachmentsPanel, CommentsPanel } from "./collab";

/**
 * Comments and attachments of one record. Reading follows the subject's read policy in the
 * database; anyone who can read the record may comment (A18), and uploads are offered to people
 * who may change the record.
 */
export async function RecordCollab({
  page,
  table,
  id,
  canChange,
}: {
  page: ModulePage;
  table: string;
  id: string;
  canChange: boolean;
}) {
  const db = page.ctx.viewer.db;
  const subject = { table, id };
  const [threads, attachments, members] = await Promise.all([
    listThreads(db, subject),
    listAttachments(db, subject),
    listMembers(db, page.ctx.org.id),
  ]);
  if (!threads.ok) throw new Error(`Cannot load comments: ${JSON.stringify(threads.error)}`);
  if (!attachments.ok)
    throw new Error(`Cannot load attachments: ${JSON.stringify(attachments.error)}`);
  const names: Record<string, string> = {};
  if (members.ok) for (const m of members.data) if (m.fullName) names[m.personId] = m.fullName;
  return (
    <>
      <CommentsPanel
        org={page.ctx.org.slug}
        subjectTable={table}
        subjectId={id}
        threads={threads.data}
        names={names}
        me={page.ctx.viewer.person?.id ?? null}
        canPost
      />
      <AttachmentsPanel
        org={page.ctx.org.slug}
        subjectTable={table}
        subjectId={id}
        attachments={attachments.data}
        canUpload={canChange}
      />
    </>
  );
}
