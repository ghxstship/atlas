"use client";

import { CollabPanels } from "@/components/work/collab";
import { RelatedRecords } from "@/components/work/related-records";
import { RegionContent } from "./region-content";
import type { ShellPeekRecord } from "@/lib/shell/peek-actions";

export { RecordPeek } from "@/components/work/record-peek";

/**
 * The sections of the shell's peek below the record's recent activity, as on its full page (Section
 * 11.2 item 4): the comment thread with its files, and the related records. Loaded with the peek
 * itself (shell-peek.tsx), never with the page. `onChange` reads the record again after a comment or
 * file changes, since the shell's peek is not part of the page the action renders again. Each
 * section fails alone, with Retry in its place (Region, A143).
 */
export function ShellPeekSections({
  org,
  record,
  onChange,
}: {
  org: string;
  record: ShellPeekRecord;
  onChange: () => void;
}) {
  return (
    <>
      <RegionContent data={record.conversation} onRetry={onChange}>
        {(conversation) => (
          <CollabPanels
            org={org}
            subject={{ table: "app.records", id: record.id }}
            threads={conversation.threads}
            attachments={conversation.attachments}
            names={conversation.names}
            me={record.me}
            canPost={!record.inTrash}
            onChange={onChange}
          />
        )}
      </RegionContent>
      <RegionContent data={record.relations} onRetry={onChange}>
        {(relations) => <RelatedRecords org={org} recordId={record.id} relations={relations} />}
      </RegionContent>
    </>
  );
}
