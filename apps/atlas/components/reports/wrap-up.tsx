import { listMembers } from "@xos/data";
import {
  DEBRIEF_AREA_SLUGS,
  DEBRIEF_AREAS,
  DEBRIEF_ITEM_KINDS,
  DEBRIEF_KIND_SLUGS,
  getDebriefSummary,
  getProjectDebrief,
  listDebriefItems,
} from "@xos/data/debriefs";
import { WRAP_UP_CAPABILITIES } from "@xos/data/documents/sources";
import { getFormatter, getLocale } from "next-intl/server";
import { DocumentActions } from "@/components/documents/document-actions";
import { WrapUpPanel } from "@/components/lazy-ui/wrap-up-panel";
import { InlineAlert } from "@/components/ui";
import { wrapUpLoadOptions } from "@/lib/documents/wrap-up";
import type { ProjectContext } from "@/lib/projects/context";
import { getTranslate } from "@/lib/shell/translate";

/**
 * The project wrap-up above the saved reports (B7, ADR 0146 decisions 5 and 6): the debrief's state, its
 * management summary, the debrief points and the wrap-up report's downloads. The summary is drafted from budget,
 * gate, incident and ledger facts, so only readers of all of them see it; others see "Not included". Writers
 * (projects.project.write) edit, complete and reopen through the on-demand panel.
 */

const P = "reports.wrapUp";
const ERRORS = [
  "debrief_completed",
  "debrief_ai_request",
  "debrief_summary",
  "refused",
  "notFound",
  "invalid",
  "unexpected",
];

export async function WrapUpSection({ ctx }: { ctx: ProjectContext }) {
  if (!ctx.capabilities.has("projects.project.read")) return null;
  const db = ctx.org.viewer.db;
  const [t, format, locale, debrief, held] = await Promise.all([
    getTranslate(),
    getFormatter(),
    getLocale(),
    getProjectDebrief(db, ctx.project.id),
    db.rpc("my_capabilities_on_project", {
      p_project_id: ctx.project.id,
      p_capabilities: [...WRAP_UP_CAPABILITIES],
    }),
  ]);
  if (!debrief.ok) return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  const reach = await wrapUpLoadOptions(ctx.org, db, locale, ctx.project.id);
  const can = new Set((held.data ?? []) as string[]);
  const summaryReadable =
    reach.ledgerRead === true && WRAP_UP_CAPABILITIES.every((c) => can.has(c));
  const canWrite = ctx.capabilities.has("projects.project.write");
  const [items, summary, members] = await Promise.all([
    debrief.data ? listDebriefItems(db, debrief.data.id) : Promise.resolve(null),
    debrief.data && summaryReadable
      ? getDebriefSummary(db, debrief.data.id)
      : Promise.resolve(null),
    canWrite ? listMembers(db, ctx.org.org.id) : Promise.resolve(null),
  ]);
  const completed = debrief.data?.completedAt ?? null;
  const state = debrief.data === null ? "notStarted" : completed ? "completed" : "open";
  const saved = summary?.ok ? summary.data : null;
  return (
    <section aria-labelledby="wrap-up" className="flex flex-col gap-12" data-testid="wrap-up">
      <header className="flex flex-wrap items-start justify-between gap-12">
        <div className="flex flex-col gap-4">
          <h2 id="wrap-up" className="m-0 text-heading-16 font-semibold">
            {t(`${P}.title`)}
          </h2>
          <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.description`)}</p>
        </div>
        <DocumentActions org={ctx.org.org.slug} kind="wrap-up-report" id={ctx.project.id} />
      </header>
      <div className="flex flex-wrap items-center gap-8">
        <span className="text-label-13 font-medium">{t(`${P}.debrief`)}</span>
        <span
          className={`inline-flex rounded-chip border border-border-subtle px-8 py-2 text-text-12 font-medium ${state === "completed" ? "text-success-text" : "text-text-secondary"}`}
        >
          {t(`${P}.states.${state}`)}
        </span>
        {completed && debrief.data ? (
          <span className="text-text-12 text-text-secondary">
            {t(`${P}.completed`, {
              name: debrief.data.completedByName ?? "",
              date: format.dateTime(new Date(completed), { dateStyle: "medium" }),
            })}
          </span>
        ) : null}
      </div>
      {summaryReadable ? (
        saved ? (
          <p className="m-0 text-text-12 text-text-secondary">
            {t(saved.aiDrafted ? `${P}.aiReviewed` : `${P}.writtenBy`, {
              name: saved.byName ?? "",
              date: saved.at ? format.dateTime(new Date(saved.at), { dateStyle: "medium" }) : "",
            })}
          </p>
        ) : null
      ) : (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.summaryNotIncluded`)}</p>
      )}
      <WrapUpPanel
        org={ctx.org.org.slug}
        projectKey={ctx.project.key}
        project={{ id: ctx.project.id, label: `${ctx.project.key} · ${ctx.project.name}` }}
        debriefId={debrief.data?.id ?? null}
        completed={completed !== null}
        canWrite={canWrite}
        summary={saved?.text ?? ""}
        summaryReadable={summaryReadable}
        points={(items?.ok ? items.data : []).map((i) => ({
          id: i.id,
          area: i.area,
          kind: i.kind,
          body: i.body,
          ownerMembershipId: i.ownerMembershipId,
          ownerName: i.ownerName,
        }))}
        owners={(members?.ok ? members.data : []).map((m) => ({
          value: m.membershipId,
          label: m.fullName ?? m.membershipId,
        }))}
        labels={{
          summaryLabel: t(`${P}.summaryLabel`),
          summaryHelp: t(`${P}.summaryHelp`),
          saveSummary: t(`${P}.saveSummary`),
          summarySaved: t(`${P}.summarySaved`),
          useSummary: t(`${P}.useSummary`),
          aiPending: t(`${P}.aiPending`),
          points: t(`${P}.points`),
          area: t(`${P}.areaLabel`),
          kind: t(`${P}.kindLabel`),
          point: t(`${P}.point`),
          owner: t(`${P}.owner`),
          noOwner: t(`${P}.noOwner`),
          addPoint: t(`${P}.addPoint`),
          savePoint: t(`${P}.savePoint`),
          edit: t(`${P}.edit`),
          delete: t(`${P}.delete`),
          cancel: t(`${P}.cancel`),
          trashed: t(`${P}.trashed`),
          noPoints: t(`${P}.noPoints`),
          complete: t(`${P}.complete`),
          reopen: t(`${P}.reopen`),
          areas: DEBRIEF_AREAS.map((a) => ({
            value: a,
            label: t(`${P}.area.${DEBRIEF_AREA_SLUGS[a]}`),
          })),
          kinds: DEBRIEF_ITEM_KINDS.map((k) => ({
            value: k,
            label: t(`${P}.kind.${DEBRIEF_KIND_SLUGS[k]}`),
          })),
          errors: Object.fromEntries(ERRORS.map((e) => [e, t(`${P}.errors.${e}`)])),
        }}
      />
    </section>
  );
}
