import {
  getReconciliation,
  listReconciliations,
  type ReconciliationSummary,
} from "@xos/data/advancing";
import type { RecordState } from "@xos/ui";
import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { EmptyStateLink } from "@/components/ui";
import { peekRowMissing } from "@/lib/shell/peek-handoff";
import { getTranslate } from "@/lib/shell/translate";
import type { AdvancingContext } from "./context";
import { RecordCollab } from "./record-collab";
import { Panel, RunReconciliationForm } from "./forms";
import { pickView, Property, withQuery, type Search } from "./shared";
import { InlineAlert, PageHeader, ReconciliationTable, StateChip, Tag, TemplateRecord } from "./ui";
import { PeekPanel, PeekTable, SelectFilter, ViewSwitcher } from "./views";

const VIEWS = ["table", "matrix"] as const;
const RESULTS = ["met", "gap", "unknown"] as const;

/** A run with any gate 3 gap blocks gate 3 (G3.NO_CRITICAL_GAPS); one with only plain Unknowns is in review. */
function runState(r: ReconciliationSummary): {
  state: RecordState;
  key: "Gaps" | "Unknowns" | "Clear";
} {
  if (r.gate3Gaps > 0) return { state: "blocked", key: "Gaps" };
  if (r.unknown > 0) return { state: "in-review", key: "Unknowns" };
  return { state: "complete", key: "Clear" };
}

/**
 * Reconciliation (Section 4.5.5): runs of a project's requirements against what its venue and
 * vendors state they provide, under the silence rule (an absent or UNKNOWN claim is Unknown, never
 * Met). Table of runs, a matrix of the latest run per project by result, a peek and a full page.
 */
export async function ReconciliationCollection({
  actx,
  path,
  search,
  title,
  ridersHref,
}: {
  actx: AdvancingContext;
  path: string;
  search: Search;
  title: string;
  ridersHref: string;
}) {
  const { ctx, can, projects, project } = actx;
  const t = await getTranslate();
  const format = await getFormatter();
  const peekId = search["peek"];
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });

  if (peekId && search["full"] === "1") {
    return (
      <RunPage
        actx={actx}
        runId={peekId}
        backHref={withQuery(path, search, { peek: null, full: null })}
      />
    );
  }

  const result = await listReconciliations(ctx.viewer.db, {
    orgId: ctx.org.id,
    ...(project ? { projectId: project.id } : {}),
  });
  if (!result.ok) throw new Error(`Cannot list reconciliations: ${JSON.stringify(result.error)}`);
  const runs = result.data;
  const view = pickView(search, VIEWS, "table");
  const projectOf = (id: string) => projects.find((p) => p.id === id);
  const projectLabel = (p: { key: string; name: string }) => `${p.key} · ${p.name}`;
  const fixedProject = actx.project !== null && search["project"] === undefined;
  const peekRun = peekId ? runs.find((r) => r.id === peekId) : undefined;
  if (peekId && !peekRun) notFound();
  const latest = projects
    .map((p) => ({ project: p, run: runs.find((r) => r.projectId === p.id) }))
    .filter(
      (x): x is { project: (typeof projects)[number]; run: ReconciliationSummary } =>
        x.run !== undefined,
    );

  return (
    <div className="flex flex-col gap-12 min-w-0">
      <PageHeader
        title={title}
        count={runs.length}
        views={<ViewSwitcher views={VIEWS} current={view} />}
      />
      {fixedProject ? null : (
        <div className="flex flex-wrap items-end gap-8">
          <SelectFilter
            id="reconciliation-project"
            label={t("advancing.common.project")}
            param="project"
            value={project?.key ?? ""}
            options={[
              { value: "", label: t("advancing.common.allProjects") },
              ...projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
            ]}
          />
        </div>
      )}
      {can.reconcile && projects.length > 0 ? (
        <RunReconciliationForm
          org={ctx.org.slug}
          projects={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
          defaultProjectId={project?.id ?? null}
        />
      ) : null}
      {runs.length === 0 ? (
        <EmptyStateLink
          icon="Scale"
          sentence={
            can.reconcile
              ? t("advancing.reconciliation.empty")
              : t("advancing.reconciliation.emptyReadOnly")
          }
          actionLabel={t("advancing.reconciliation.viewRiders")}
          href={ridersHref}
        />
      ) : view === "matrix" ? (
        <div
          role="region"
          aria-label={t("advancing.reconciliation.matrixCaption")}
          tabIndex={0}
          className="overflow-x-auto"
        >
          <table className="w-full border-collapse text-text-13">
            <caption className="sr-only">{t("advancing.reconciliation.matrixCaption")}</caption>
            <thead>
              <tr className="border-b border-border-subtle text-start">
                <th scope="col" className="px-8 py-6 text-start font-medium">
                  {t("advancing.common.project")}
                </th>
                {RESULTS.map((r) => (
                  <th key={r} scope="col" className="px-8 py-6 text-end font-medium">
                    {t(`advancing.reconciliation.results.${r}`)}
                  </th>
                ))}
                <th scope="col" className="px-8 py-6 text-end font-medium">
                  {t("advancing.reconciliation.gate3")}
                </th>
              </tr>
            </thead>
            <tbody>
              {latest.map(({ project: p, run }) => (
                <tr key={p.id} className="border-b border-border-subtle">
                  <th scope="row" className="px-8 py-6 text-start font-normal">
                    <Link
                      href={withQuery(path, search, { peek: run.id, full: "1" }) as Route}
                      className="hover:underline"
                    >
                      {projectLabel(p)}
                    </Link>
                  </th>
                  <td className="px-8 py-6 text-end tabular-nums">{run.met}</td>
                  <td className="px-8 py-6 text-end tabular-nums">{run.gap}</td>
                  <td className="px-8 py-6 text-end tabular-nums">{run.unknown}</td>
                  <td className="px-8 py-6 text-end tabular-nums">{run.gate3Gaps}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="m-0 pt-8 text-text-12 text-text-tertiary">
            {t("advancing.reconciliation.matrixNote", { count: latest.length })}
          </p>
        </div>
      ) : (
        <PeekTable
          caption={title}
          columns={[
            { key: "when", label: t("advancing.reconciliation.columns.when") },
            { key: "project", label: t("advancing.common.project"), type: "code" },
            { key: "state", label: t("advancing.common.state") },
            { key: "met", label: t("advancing.reconciliation.results.met"), type: "number" },
            { key: "gap", label: t("advancing.reconciliation.results.gap"), type: "number" },
            {
              key: "unknown",
              label: t("advancing.reconciliation.results.unknown"),
              type: "number",
            },
            { key: "gate3", label: t("advancing.reconciliation.gate3"), type: "number" },
          ]}
          rows={runs.map((r) => ({
            id: r.id,
            when: when(r.reconciledAt),
            project: projectOf(r.projectId)?.key ?? "",
            state: t(`advancing.reconciliation.states.${runState(r).key}`),
            met: r.met,
            gap: r.gap,
            unknown: r.unknown,
            gate3: r.gate3Gaps,
          }))}
        />
      )}
      {peekRun ? (
        <PeekPanel
          title={t("advancing.reconciliation.runTitle", { date: when(peekRun.reconciledAt) })}
          state={runState(peekRun).state}
          stateLabel={t(`advancing.reconciliation.states.${runState(peekRun).key}`)}
          properties={[
            {
              label: t("advancing.common.project"),
              value: projectOf(peekRun.projectId)?.key ?? "",
            },
            { label: t("advancing.reconciliation.results.met"), value: peekRun.met },
            { label: t("advancing.reconciliation.results.gap"), value: peekRun.gap },
            { label: t("advancing.reconciliation.results.unknown"), value: peekRun.unknown },
            { label: t("advancing.reconciliation.gate3"), value: peekRun.gate3Gaps },
          ]}
        />
      ) : null}
    </div>
  );
}

async function RunPage({
  actx,
  runId,
  backHref,
}: {
  actx: AdvancingContext;
  runId: string;
  backHref: string;
}) {
  const result = await getReconciliation(actx.ctx.viewer.db, runId);
  if (!result.ok) {
    if (peekRowMissing(result.error)) notFound();
    throw new Error(`Cannot read reconciliation: ${JSON.stringify(result.error)}`);
  }
  const run = result.data;
  if (actx.project && run.projectId !== actx.project.id) notFound();
  const t = await getTranslate();
  const format = await getFormatter();
  const project = actx.projects.find((p) => p.id === run.projectId);
  const s = runState(run);
  const when = format.dateTime(new Date(run.reconciledAt), {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const statementLabel = (description: string, urid: string) => `${urid} · ${description}`;
  return (
    <TemplateRecord
      propertiesLabel={t("advancing.common.properties")}
      header={
        <div className="flex flex-col gap-8">
          <Link
            href={backHref as Route}
            className="text-text-13 text-text-secondary hover:text-text-primary"
          >
            {t("advancing.reconciliation.back")}
          </Link>
          <div className="flex flex-wrap items-center gap-8">
            {project ? <Tag>{project.key}</Tag> : null}
            <h1 className="m-0 text-heading-20 font-semibold">
              {t("advancing.reconciliation.runTitle", { date: when })}
            </h1>
            <StateChip state={s.state} label={t(`advancing.reconciliation.states.${s.key}`)} />
          </div>
        </div>
      }
      properties={
        <dl className="m-0 flex flex-col">
          <Property label={t("advancing.common.project")}>
            {project ? `${project.key} · ${project.name}` : ""}
          </Property>
          <Property label={t("advancing.reconciliation.columns.when")}>{when}</Property>
          <Property label={t("advancing.reconciliation.results.met")}>{run.met}</Property>
          <Property label={t("advancing.reconciliation.results.gap")}>{run.gap}</Property>
          <Property label={t("advancing.reconciliation.results.unknown")}>{run.unknown}</Property>
          <Property label={t("advancing.reconciliation.gate3")}>{run.gate3Gaps}</Property>
          {run.note ? (
            <Property label={t("advancing.reconciliation.note")}>{run.note}</Property>
          ) : null}
        </dl>
      }
    >
      {run.gate3Gaps > 0 ? (
        <InlineAlert tone="danger" title={t("advancing.reconciliation.gate3Title")}>
          {t("advancing.reconciliation.gate3Sentence", { count: run.gate3Gaps })}
        </InlineAlert>
      ) : null}
      <Panel id="run-lines" title={t("advancing.reconciliation.lines")}>
        <ReconciliationTable
          label={t("advancing.reconciliation.lines")}
          rows={run.lines.map((l) => ({
            requirement: `${statementLabel(l.requirement.description, l.requirement.urid)}${l.requirement.isCritical ? ` · ${t("advancing.reconciliation.critical")}` : ""}`,
            capability: l.capability
              ? `${statementLabel(l.capability.description, l.capability.urid)} · ${l.capability.assertionWord}`
              : null,
            result: l.result,
          }))}
        />
      </Panel>
      <RecordCollab
        actx={actx}
        table="app.reconciliations"
        id={run.id}
        canUpload={actx.can.reconcile}
      />
    </TemplateRecord>
  );
}
