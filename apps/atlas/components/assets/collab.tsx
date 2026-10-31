import type { XosClient } from "@xos/data";
import { listAttachments } from "@xos/data/attachments";
import { listThreads } from "@xos/data/comments";
import { listPeopleNames } from "@xos/data/safety-permits";
import { RecordHistory } from "@/components/history/record-history";
import { AssetCollabPanel } from "./collab-panel";

export type AssetSubjectTable =
  | "app.asset_classes"
  | "app.asset_units"
  | "app.asset_lots"
  | "app.asset_maintenance"
  | "app.asset_damage";

/**
 * Loads and renders the field history (A131), comments and attachments of one asset row. Reads follow the subject's own
 * read policy through A18's private.can_read_subject; a failed read throws to the segment's error
 * boundary rather than showing an empty thread.
 */
export async function AssetCollab({
  db,
  org,
  table,
  id,
  me,
}: {
  db: XosClient;
  org: string;
  table: AssetSubjectTable;
  id: string;
  me: string | null;
}) {
  const subject = { table, id };
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
      <RecordHistory db={db} table={table} id={id} />
      <AssetCollabPanel
        org={org}
        table={table}
        id={id}
        threads={threads.data}
        attachments={attachments.data}
        names={Object.fromEntries(names.data)}
        me={me}
      />
    </>
  );
}
