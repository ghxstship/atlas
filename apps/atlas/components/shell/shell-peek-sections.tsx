"use client";

import { useTranslations } from "next-intl";
import { FieldHistoryList } from "@/components/history/field-history-list";
import { CollabPanels } from "@/components/work/collab";
import { RelatedRecords } from "@/components/work/related-records";
import type { ShellPeekRecord } from "@/lib/shell/peek-actions";

export { RecordPeek } from "@/components/work/record-peek";

/**
 * The sections of the shell's peek below the record's recent activity, as on its full page (Section
 * 11.2 item 4): the field history (A131), the comment thread with its files, and the related records. Loaded with the peek
 * itself (shell-peek.tsx), never with the page. `onChange` reads the record again after a comment or
 * file changes, since the shell's peek is not part of the page the action renders again.
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
  const t = useTranslations("collab.history");
  return (
    <>
      {record.fieldHistory ? (
        <FieldHistoryList
          id={record.id}
          title={t("title")}
          empty={t("empty")}
          items={record.fieldHistory}
        />
      ) : null}
      <CollabPanels
        org={org}
        subject={{ table: "app.records", id: record.id }}
        threads={record.conversation.threads}
        attachments={record.conversation.attachments}
        names={record.conversation.names}
        me={record.me}
        canPost={!record.inTrash}
        onChange={onChange}
      />
      <RelatedRecords org={org} recordId={record.id} relations={record.relations} />
    </>
  );
}
