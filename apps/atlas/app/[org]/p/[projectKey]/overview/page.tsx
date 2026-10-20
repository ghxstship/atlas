import { labelActivity, listActivity } from "@xos/data/activity";
import { listProductionStateHistory, listProjectStateHistory } from "@xos/data/projects";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import type { Route } from "next";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { AttachmentsPanel, CommentsPanel } from "@/components/projects/collab-panels";
import { ReadinessPanel } from "@/components/projects/readiness-panel";
import { TransitionDialog } from "@/components/projects/transition-dialog";
import { PageHeader, PropertyList, StateChip, TemplateRecord } from "@/components/projects/ui";
import { requireNode } from "@/lib/shell/require-node";
import { getProjectContextFor } from "@/lib/projects/context";
import { phaseCode, stateIcon } from "@/lib/projects/format";
import {
  loadCollaboration,
  loadGates,
  loadTransitions,
  must,
  optional,
} from "@/lib/projects/loaders";
import { nodeHref } from "@/lib/shell/sitemap";

/**
 * Project Overview (Section 4.5.4, Record template): phase and gate readiness, key dates, the
 * lifecycle states with their moves, open blockers, recent activity, comments and attachments,
 * beside the 320 px property column.
 */
export default async function OverviewPage({
  params,
}: PageProps<"/[org]/p/[projectKey]/overview">) {
  const routeParams = await params;
  await requireNode("project.overview", routeParams);
  const ctx = await getProjectContextFor(routeParams);
  if (!ctx) notFound();
  const { project } = ctx;
  const db = ctx.org.viewer.db;
  const t = await getTranslations("projects");
  const a = await getTranslations("activity.feed");
  const format = await getFormatter();
  const [gates, moves, collab, activity, stateHistory, productionHistory] = await Promise.all([
    loadGates(ctx),
    loadTransitions(ctx),
    loadCollaboration(ctx),
    listActivity(db, { orgId: ctx.org.org.id, projectId: project.id, limit: 8 }),
    listProjectStateHistory(db, project.id),
    listProductionStateHistory(db, project.id),
  ]);
  const canSettings = ctx.capabilities.has("projects.settings.write");
  const canWrite = ctx.capabilities.has("projects.project.write");
  const gate = gates.currentGate;
  const phase = gates.phases.find((p) => p.code === project.phaseCode);
  const next = gate !== null ? gates.phases.find((p) => p.gate === gate + 1) : undefined;
  const met = new Set(gates.statuses.filter((s) => s.evidenceCount > 0).map((s) => s.criterionId));
  const current = gate === null ? [] : gates.criteria.filter((c) => c.gate === gate);
  const gatesHref = nodeHref("project.gates", routeParams) ?? "";
  const date = (iso: string | null) =>
    iso === null
      ? t("values.noDates")
      : format.dateTime(new Date(`${iso}T00:00:00`), { dateStyle: "medium" });
  const history = must(stateHistory, "project state history");
  const productionLog = must(productionHistory, "production state history");
  // Field has no activity feed (Section 4.5.9), and the feed answers not-found: leave it out.
  const feed = optional(activity, "project activity");
  const activityHref = nodeHref("project.activity", routeParams);

  return (
    <>
      <PageHeader title={t("overview.title")} />
      <TemplateRecord
        propertiesLabel={t("overview.properties")}
        header={null}
        properties={
          <div className="flex flex-col gap-20">
            <PropertyList
              items={[
                {
                  label: t("fields.state"),
                  value: (
                    <span className="flex flex-wrap items-center gap-6">
                      <StateChip
                        state={stateIcon(project.projectState)}
                        label={t(`states.${project.projectState}`)}
                      />
                      {canSettings ? (
                        <TransitionDialog
                          org={ctx.org.org.slug}
                          projectKey={project.key}
                          lifecycle="project"
                          current={project.projectState}
                          allowed={moves.project}
                        />
                      ) : null}
                    </span>
                  ),
                },
                {
                  label: t("fields.production"),
                  value: (
                    <span className="flex flex-wrap items-center gap-6">
                      <StateChip
                        state={stateIcon(project.productionState)}
                        label={t(`states.${project.productionState}`)}
                      />
                      {canSettings ? (
                        <TransitionDialog
                          org={ctx.org.org.slug}
                          projectKey={project.key}
                          lifecycle="production"
                          current={project.productionState}
                          allowed={moves.production}
                        />
                      ) : null}
                    </span>
                  ),
                },
                {
                  label: t("fields.phase"),
                  value: phase
                    ? `${t("overview.phaseOf", { gate: phase.gate, total: gates.phases.length })} · ${t(`phases.${phaseCode(phase.code)}`)}`
                    : project.phaseCode,
                },
                {
                  label: t("fields.jurisdiction"),
                  value: project.jurisdictionId ?? t("values.unresolved"),
                },
                { label: t("fields.venue"), value: project.venueName ?? t("values.none") },
                { label: t("fields.region"), value: project.regionCode ?? t("values.none") },
                { label: t("fields.tier"), value: project.tierCode ?? t("values.none") },
                { label: t("fields.currency"), value: project.currency },
                { label: t("fields.timeZone"), value: project.timeZone },
                { label: t("fields.startsOn"), value: date(project.startsOn) },
                { label: t("fields.endsOn"), value: date(project.endsOn) },
              ]}
            />
            <section aria-labelledby="state-history" className="flex flex-col gap-8">
              <h2 id="state-history" className="m-0 text-label-13 font-semibold">
                {t("overview.history")}
              </h2>
              <ol className="m-0 flex list-none flex-col gap-6 p-0 text-text-12 text-text-secondary">
                {[...history, ...productionLog]
                  .sort((x, y) => (x.at < y.at ? 1 : -1))
                  .slice(0, 8)
                  .map((h) => (
                    <li key={h.id}>
                      <span className="text-text-primary">
                        {h.fromState === null
                          ? t("overview.created", { to: t(`states.${h.toState}`) })
                          : t("overview.historyEntry", {
                              from: t(`states.${h.fromState}`),
                              to: t(`states.${h.toState}`),
                            })}
                      </span>{" "}
                      {h.actor ? t("overview.by", { name: h.actor }) : t("overview.system")}
                      {" · "}
                      <time dateTime={h.at}>
                        {format.dateTime(new Date(h.at), { dateStyle: "medium" })}
                      </time>
                      {h.fromState !== null ? <span className="block">{h.reason}</span> : null}
                    </li>
                  ))}
              </ol>
            </section>
          </div>
        }
      >
        {gate !== null && phase ? (
          <ReadinessPanel
            href={gatesHref}
            gate={gate}
            code={phaseCode(phase.code)}
            name={t(`phases.${phaseCode(phase.code)}`)}
            nextLabel={
              next
                ? t("gates.passTitle", { gate, next: t(`phases.${phaseCode(next.code)}`) })
                : t("gates.passTitleLast", { gate })
            }
            criteria={current.map((c) => ({
              code: c.id,
              label: c.statement,
              result: met.has(c.id) ? "met" : "gap",
              blocking: c.blocking,
            }))}
          />
        ) : (
          <p className="m-0 text-text-14">{t("overview.allPassed")}</p>
        )}
        <section aria-labelledby="open-blockers" className="flex flex-col gap-8">
          <h2 id="open-blockers" className="m-0 text-heading-16 font-semibold">
            {t("overview.blockers")}
          </h2>
          {current.filter((c) => c.blocking && !met.has(c.id)).length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("overview.noBlockers")}</p>
          ) : (
            <ul className="m-0 flex list-disc flex-col gap-4 ps-20 text-text-13">
              {current
                .filter((c) => c.blocking && !met.has(c.id))
                .map((c) => (
                  <li key={c.id}>
                    <span className="font-mono text-text-12 text-text-secondary">{c.id}</span>{" "}
                    {c.statement}
                  </li>
                ))}
            </ul>
          )}
          <p className="m-0">
            <Link href={gatesHref as Route} className="text-text-13 text-accent-text underline">
              {t("overview.openGates")}
            </Link>
          </p>
        </section>
        {feed ? (
          <section aria-labelledby="recent-activity" className="flex flex-col gap-8">
            <h2 id="recent-activity" className="m-0 text-heading-16 font-semibold">
              {t("overview.recent")}
            </h2>
            <ActivityFeed
              label={a("projectLabel", { key: project.key })}
              entries={await labelActivity(db, feed.entries)}
              views={["feed"]}
              view="feed"
              next={null}
              paged={false}
              empty={{
                sentence: a("projectEmpty"),
                action: t("overview.openGates"),
                href: gatesHref,
              }}
            />
            {activityHref ? (
              <p className="m-0">
                <Link
                  href={activityHref as Route}
                  className="text-text-13 text-accent-text underline"
                >
                  {t("overview.allActivity")}
                </Link>
              </p>
            ) : null}
          </section>
        ) : null}
        <CommentsPanel
          org={ctx.org.org.slug}
          projectKey={project.key}
          threads={collab.threads}
          names={collab.names}
          me={ctx.org.viewer.person?.id ?? null}
          canPost
        />
        <AttachmentsPanel
          org={ctx.org.org.slug}
          projectKey={project.key}
          attachments={collab.attachments}
          canUpload={canWrite}
        />
      </TemplateRecord>
    </>
  );
}
