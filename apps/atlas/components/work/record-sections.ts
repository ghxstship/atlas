import { listAttachments, type Attachment } from "@xos/data/attachments";
import { listThreads, type Subject, type Thread } from "@xos/data/comments";
import { listRecordLinks } from "@xos/data/custom-objects";
import { personNames } from "@xos/data/person-names";
import { listDependencies, type Dependency } from "@xos/data/schedule";
import { getRecordFamily, listRecords, type RecordSummary } from "@xos/data/work";
import type { OrgContext } from "@/lib/shell/context";
import { must } from "./load";
import type { RecordRelations, RelatedRecord } from "./related-records";

/*
 * What a record shows beside its properties in its side peek and on its full page (Section 11.2
 * item 4, Record template): its comment thread with its files, and its related records. The full
 * page and the work peeks (record-detail.tsx), the shell's peek (lib/shell/peek-actions.ts) and the
 * custom object peek read them here, so each shows the same sections from the same reads.
 */

/** A subject's comments and files, with the names of the people who wrote the comments. */
export interface Conversation {
  readonly threads: readonly Thread[];
  readonly attachments: readonly Attachment[];
  /** Comment authors by person id, as far as the viewer may know them (app.person_names). */
  readonly names: Readonly<Record<string, string>>;
}

export async function loadConversation(ctx: OrgContext, subject: Subject): Promise<Conversation> {
  const db = ctx.viewer.db;
  const [threads, attachments] = await Promise.all([
    listThreads(db, subject),
    listAttachments(db, subject),
  ]);
  const list = must(threads, "comments");
  const names = await personNames(
    db,
    list.flatMap((th) => th.comments.map((c) => c.authorPersonId)),
  );
  return {
    threads: list,
    attachments: must(attachments, "attachments"),
    names: Object.fromEntries(names),
  };
}

const related = (r: RecordSummary): RelatedRecord => ({
  id: r.id,
  key: r.key,
  title: r.title,
  kind: r.kind,
  state: r.state,
});

/**
 * A record's related records, read as the viewer: a record they cannot read shows as hidden. The
 * dependencies come back as read too, for the dependency editor.
 */
export async function loadRelations(
  ctx: OrgContext,
  recordId: string,
): Promise<{ relations: RecordRelations; dependencies: readonly Dependency[] }> {
  const db = ctx.viewer.db;
  const [family, deps, links] = await Promise.all([
    getRecordFamily(db, ctx.org.id, recordId),
    listDependencies(db, [recordId]),
    listRecordLinks(db, recordId),
  ]);
  const { parent, parentHidden, children } = must(family, "parent and sub-records");
  const dependencies = must(deps, "dependencies");
  const ends = [
    ...new Set(
      dependencies.map((d) => (d.predecessorId === recordId ? d.successorId : d.predecessorId)),
    ),
  ];
  const others =
    ends.length > 0
      ? must(await listRecords(db, { orgId: ctx.org.id, ids: ends }), "dependent records")
      : [];
  const byId = new Map(others.map((r) => [r.id, related(r)]));
  const end = (d: Dependency, id: string) => ({
    id: d.id,
    type: d.type,
    record: byId.get(id) ?? null,
  });
  return {
    relations: {
      parent: parent ? related(parent) : null,
      parentHidden,
      children: children.map(related),
      waitsOn: dependencies
        .filter((d) => d.successorId === recordId)
        .map((d) => end(d, d.predecessorId)),
      holdsUp: dependencies
        .filter((d) => d.predecessorId === recordId)
        .map((d) => end(d, d.successorId)),
      links: must(links, "linked custom object records"),
    },
    dependencies,
  };
}
