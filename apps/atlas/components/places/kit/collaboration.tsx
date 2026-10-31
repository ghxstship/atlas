import type { XosClient } from "@xos/data";
import { listAttachments } from "@xos/data/attachments";
import { listThreads } from "@xos/data/comments";
import { listPeopleNames } from "@xos/data/safety-permits";
import { RecordHistory } from "@/components/history/record-history";
import { CollabPanels } from "./collab";
import type { CollabSubject } from "./collab-actions";

/**
 * Loads and renders the field history (A131), comments and attachments of one Places or Safety row. Reads follow the
 * subject's own read policy through A18's private.can_read_subject; a failed read throws to the
 * region's error boundary rather than showing an empty thread.
 */
export async function Collaboration({
  db,
  org,
  subject,
  me,
  canPost,
}: {
  db: XosClient;
  org: string;
  subject: CollabSubject;
  me: string | null;
  canPost: boolean;
}) {
  const [threads, attachments] = await Promise.all([
    listThreads(db, subject),
    listAttachments(db, subject),
  ]);
  if (!threads.ok) throw new Error(`Cannot read comments: ${JSON.stringify(threads.error)}`);
  if (!attachments.ok) {
    throw new Error(`Cannot read attachments: ${JSON.stringify(attachments.error)}`);
  }
  const authors = threads.data.flatMap((th) => th.comments.map((c) => c.authorPersonId));
  const names = await listPeopleNames(db, authors);
  if (!names.ok) throw new Error(`Cannot read names: ${JSON.stringify(names.error)}`);
  return (
    <>
      <RecordHistory db={db} table={subject.table} id={subject.id} />
      <CollabPanels
        org={org}
        subject={subject}
        threads={threads.data}
        attachments={attachments.data}
        names={Object.fromEntries(names.data)}
        me={me}
        canPost={canPost}
      />
    </>
  );
}
