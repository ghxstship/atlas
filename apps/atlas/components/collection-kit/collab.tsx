import { listMembers } from "@xos/data";
import { listAttachments } from "@xos/data/attachments";
import { listThreads } from "@xos/data/comments";
import { Region } from "@/components/shell/region";
import { getCopy } from "@/lib/collection-kit/i18n";
import type { OrgContext } from "@/lib/shell/context";
import { CollabClient } from "./collab-client";
import { ErrorPanel } from "./kit";

interface CollabPanelsProps {
  ctx: OrgContext;
  table: string;
  id: string;
}

/**
 * The comments and attachments of one A16 row. They fail alone (A143): an error while they load or
 * render, a read that throws included, shows Retry in their place and leaves the record's panel.
 */
export function CollabPanels(props: CollabPanelsProps) {
  return (
    <Region>
      <LoadedCollabPanels {...props} />
    </Region>
  );
}

/** Loads the comments and attachments of one A16 row and renders their panels. */
async function LoadedCollabPanels({ ctx, table, id }: CollabPanelsProps) {
  const db = ctx.viewer.db;
  const subject = { table, id };
  const [threads, attachments, members, t] = await Promise.all([
    listThreads(db, subject),
    listAttachments(db, subject),
    listMembers(db, ctx.org.id),
    getCopy("procurement.kit.collab"),
  ]);
  if (!threads.ok || !attachments.ok) return <ErrorPanel what={t("what")} />;
  const names = new Map(
    (members.ok ? members.data : []).map((m) => [m.personId, m.fullName ?? t("someone")]),
  );
  const me = ctx.viewer.person?.id ?? null;
  const comments = threads.data
    .flatMap((th) => th.comments)
    .map((c) => ({
      id: c.id,
      author: names.get(c.authorPersonId) ?? t("someone"),
      mine: c.authorPersonId === me,
      body: c.body,
      createdAt: c.createdAt,
      deleted: c.deletedAt !== null,
    }));
  const files = attachments.data.map((a) => ({
    id: a.id,
    title: a.title,
    filename: a.current?.filename ?? null,
    sizeBytes: a.current?.sizeBytes ?? null,
    ready: a.current !== null,
    mine: a.createdBy === me,
    classification: a.classification,
  }));
  return (
    <CollabClient
      org={ctx.org.slug}
      table={table}
      id={id}
      comments={comments}
      attachments={files}
    />
  );
}
