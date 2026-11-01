import { listAttachments } from "@xos/data/attachments";
import { listThreads } from "@xos/data/comments";
import { getBaselineVariance, listBaselines } from "@xos/data/schedule";
import type { ProjectRef } from "@xos/data/work";
import { getNode } from "@xos/ia";
import type { ReactNode } from "react";
import { collectionPeek } from "@/components/shell/collection-peek";
import { CollabPanels } from "@/components/work/collab";
import { RecordHistory } from "@/components/history/record-history";
import {
  capabilitySet,
  loadRecordMeta,
  must,
  nodeViews,
  param,
  type SearchParams,
} from "@/components/work/load";
import type { OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { BaselineCollection, BaselinePeek } from "./baselines";
import { CaptureBaselineDialog } from "./schedule-panels";

/** Schedule > Baselines, and a project's baselines. */
export async function BaselinesPage({
  ctx,
  node,
  search,
  project,
}: {
  ctx: OrgContext;
  node: string;
  search: SearchParams;
  project?: ProjectRef;
}) {
  const t = await getTranslate();
  const db = ctx.viewer.db;
  const { views, defaultView } = nodeViews(node);
  const requested = param(search, "view");
  const view = requested && views.includes(requested) ? requested : defaultView;
  const [meta, caps, baselines] = await Promise.all([
    loadRecordMeta(ctx),
    capabilitySet(ctx),
    listBaselines(db, { orgId: ctx.org.id, ...(project ? { projectId: project.id } : {}) }),
  ]);
  let peek: ReactNode = null;
  const peekId = param(search, "peek");
  if (peekId && /^[0-9a-f-]{36}$/.test(peekId)) {
    const found = await getBaselineVariance(db, ctx.org.id, peekId);
    if (found.ok) {
      const subject = { table: "app.schedule_baselines" as const, id: peekId };
      const [threads, attachments] = await Promise.all([
        listThreads(db, subject),
        listAttachments(db, subject),
      ]);
      peek = (
        <BaselinePeek baseline={found.data.baseline} variance={found.data.variance}>
          <>
            <RecordHistory db={db} table={subject.table} id={subject.id} />
            <CollabPanels
              org={ctx.org.slug}
              subject={subject}
              threads={must(threads, "comments")}
              attachments={must(attachments, "attachments")}
              names={Object.fromEntries(
                meta.people.map((p) => [p.personId, p.name ?? t("work.values.unnamed")]),
              )}
              me={ctx.viewer.person?.id ?? null}
              canPost
            />
          </>
        </BaselinePeek>
      );
    } else if (found.error.kind !== "not-found") {
      throw new Error(`Cannot load baseline: ${JSON.stringify(found.error)}`);
    }
  }
  return (
    <BaselineCollection
      org={ctx.org.slug}
      title={t(getNode(sitemap, node).node.label)}
      baselines={must(baselines, "baselines")}
      views={views}
      view={view}
      canCapture={caps.has("schedule.baseline.write")}
      capture={
        <CaptureBaselineDialog
          org={ctx.org.slug}
          projects={project ? [project] : meta.projects}
          defaultProjectId={project?.id ?? null}
          open={param(search, "create") === "1"}
        />
      }
      peek={collectionPeek(peekId, peek)}
    />
  );
}
