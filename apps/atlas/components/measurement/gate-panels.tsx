import { todayIn } from "@xos/data/calendar";
import {
  COVERAGE_MEDIUMS,
  COVERAGE_TONES,
  OBJECTIVE_DIRECTIONS,
  listEarnedMediaItems,
  listMeasurementCatalog,
  listMeasurementCorrections,
  listMeasurementSummary,
  listProjectMeasurements,
  listProjectObjectives,
  ticketingAttendance,
  toneBreakdown,
  type EarnedMediaItem,
  type MeasurementCatalog,
  type MeasurementCorrection,
  type MeasurementSummaryRow,
  type ProjectMeasurement,
  type ProjectObjective,
  type TicketingAttendance,
  type UnitPreference,
} from "@xos/data/measurements";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { SimpleTable } from "@/components/finance/figures";
import type { ProjectContext } from "@/lib/projects/context";
import { must } from "@/lib/projects/loaders";
import { getShellSettings } from "@/lib/shell/org-settings";
import {
  correctionLabel,
  directionLabel,
  figureText,
  mediumLabel,
  metricLabel,
  sourceLabel,
  toneLabel,
  unitName,
  type MeasurementT,
} from "./format";
import {
  AttestButton,
  CorrectFigureDialog,
  CoverageDialog,
  FigureDialog,
  ObjectiveDialog,
  WithdrawCoverageButton,
  WithdrawFigureDialog,
  WithdrawObjectiveButton,
  type UnitChoice,
} from "./forms";
import { CoverageTable } from "./coverage-table";
import { SummaryTable, summaryLines } from "./summary";

/**
 * The measurement panels of the Gates tab (A98, Section 4.10): at gate 1 the project's objectives, which gate 8
 * measures against (G1.OBJECTIVES_STATED); at gate 8 the review of audience, earned media, sentiment and sustainability
 * figures against them (G8.MEASUREMENT_REPORTED), with the coverage records, their sources and links. Both offer to
 * record themselves on the evidence spine. Days default to today on the project's calendar.
 */

export interface MeasurementData {
  readonly catalog: MeasurementCatalog;
  readonly objectives: readonly ProjectObjective[];
  readonly summary: readonly MeasurementSummaryRow[];
  readonly figures: readonly ProjectMeasurement[];
  readonly corrections: readonly MeasurementCorrection[];
  readonly coverage: readonly EarnedMediaItem[];
  readonly ticketing: TicketingAttendance | null;
  readonly preference: UnitPreference;
  readonly today: string;
}

/**
 * Everything the two panels read, once per request. A failed read throws, as the gate reads do (`must`), so the
 * route's error boundary offers a retry instead of a page without its measurement.
 */
export async function loadMeasurementData(ctx: ProjectContext): Promise<MeasurementData> {
  const db = ctx.org.viewer.db;
  const projectId = ctx.project.id;
  const [catalog, objectives, summary, figures, corrections, coverage, ticketing, shell] =
    await Promise.all([
      listMeasurementCatalog(db),
      listProjectObjectives(db, projectId),
      listMeasurementSummary(db, { orgId: ctx.org.org.id, projectId }),
      listProjectMeasurements(db, projectId),
      listMeasurementCorrections(db, projectId),
      listEarnedMediaItems(db, projectId),
      ticketingAttendance(db, projectId),
      getShellSettings(db, ctx.org.org.id, null),
    ]);
  return {
    catalog: must(catalog, "measurement catalog"),
    objectives: must(objectives, "objectives"),
    summary: must(summary, "measurement summary"),
    figures: must(figures, "figures"),
    corrections: must(corrections, "figure corrections"),
    coverage: must(coverage, "earned media"),
    ticketing: must(ticketing, "ticketing attendance"),
    preference: shell.preferences.units,
    today: todayIn(ctx.project.timeZone),
  };
}

async function copy() {
  const [t, format, locale] = await Promise.all([
    getTranslations("measurement"),
    getFormatter(),
    getLocale(),
  ]);
  return {
    t: t as unknown as MeasurementT,
    locale,
    date: (iso: string | null) =>
      iso === null
        ? ""
        : format.dateTime(new Date(`${iso.slice(0, 10)}T00:00:00`), { dateStyle: "medium" }),
    number: (n: number) => format.number(n),
  };
}

function Panel({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-12 rounded-card border border-border-subtle bg-bg-canvas p-12"
    >
      <div className="flex flex-col gap-4">
        <h3 id={id} className="m-0 text-heading-14 font-semibold">
          {title}
        </h3>
        <p className="m-0 text-text-13 text-text-secondary">{description}</p>
      </div>
      {children}
    </section>
  );
}

function unitChoices(t: MeasurementT, catalog: MeasurementCatalog): UnitChoice[] {
  return catalog.units.map((u) => ({
    value: u.code,
    label: unitName(t, u.code),
    dimension: u.dimension,
  }));
}

/** True when the project's evidence already names this record on the spine. */
export function attestedOn(
  evidence: readonly { readonly criterionId: string; readonly uri: string | null }[],
  criterionId: string,
  uri: string,
): boolean {
  return evidence.some((e) => e.criterionId === criterionId && e.uri === uri);
}

// Gate 1 -------------------------------------------------------------------------------------------------------------

export async function ObjectivesPanel({
  ctx,
  data,
  gatePassed,
  canEdit,
  canAttest,
  attested,
}: {
  ctx: ProjectContext;
  data: MeasurementData;
  gatePassed: boolean;
  /** Evidence writers while gate 1 is open; gate approvers afterwards (the database decides either way). */
  canEdit: boolean;
  canAttest: boolean;
  attested: boolean;
}) {
  const { t, locale, date } = await copy();
  const org = ctx.org.org.slug;
  const projectKey = ctx.project.key;
  const objectives = [...data.objectives].sort(
    (a, b) =>
      (data.catalog.metrics.find((m) => m.code === a.metricCode)?.ordinal ?? 0) -
      (data.catalog.metrics.find((m) => m.code === b.metricCode)?.ordinal ?? 0),
  );
  return (
    <Panel
      id="objectives-panel"
      title={t("objectives.title")}
      description={t("objectives.description")}
    >
      {gatePassed ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("objectives.locked")}</p>
      ) : null}
      {objectives.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("objectives.empty")}</p>
      ) : (
        <SimpleTable
          caption={t("objectives.caption")}
          head={[
            t("fields.metric"),
            t("fields.target"),
            t("fields.note"),
            t("objectives.setBy"),
            ...(canEdit ? [t("actions")] : []),
          ]}
          rows={objectives.map((o) => [
            metricLabel(t, o.metricCode),
            `${directionLabel(t, o.direction)} ${figureText(t, locale, o.targetValue, o.unitCode)}`,
            o.note ?? "",
            o.setBy ? t("byOn", { name: o.setBy, date: date(o.updatedAt) }) : date(o.updatedAt),
            ...(canEdit
              ? [
                  <WithdrawObjectiveButton
                    key="w"
                    org={org}
                    projectKey={projectKey}
                    objectiveId={o.id}
                    metric={metricLabel(t, o.metricCode)}
                  />,
                ]
              : []),
          ])}
        />
      )}
      {canEdit ? (
        <ObjectiveDialog
          org={org}
          projectKey={projectKey}
          metrics={data.catalog.metrics.map((m) => ({
            value: m.code,
            label: metricLabel(t, m.code),
            dimension: m.dimension,
          }))}
          units={unitChoices(t, data.catalog)}
          directions={OBJECTIVE_DIRECTIONS.map((d) => ({ value: d, label: directionLabel(t, d) }))}
          objectives={Object.fromEntries(
            objectives.map((o) => [
              o.metricCode,
              {
                id: o.id,
                direction: o.direction,
                targetValue: o.targetValue,
                unitCode: o.unitCode,
                note: o.note,
              },
            ]),
          )}
        />
      ) : null}
      {attested ? (
        <p className="m-0 text-text-13 text-success-text">{t("objectives.attested")}</p>
      ) : canAttest && !gatePassed && objectives.length > 0 ? (
        <AttestButton
          org={org}
          projectKey={projectKey}
          kind="objectives"
          note={t("objectives.attestNote", { count: objectives.length })}
          label={t("objectives.attest")}
          success={t("objectives.attested")}
        />
      ) : null}
    </Panel>
  );
}

// Gate 8 -------------------------------------------------------------------------------------------------------------

export async function MeasurementPanel({
  ctx,
  data,
  canWrite,
  canAttest,
  attested,
}: {
  ctx: ProjectContext;
  data: MeasurementData;
  canWrite: boolean;
  canAttest: boolean;
  attested: boolean;
}) {
  const { t, locale, date, number } = await copy();
  const org = ctx.org.org.slug;
  const projectKey = ctx.project.key;
  const lines = summaryLines(
    t,
    locale,
    data.catalog,
    data.summary,
    ctx.project.id,
    data.preference,
  );
  const metricOf = new Map(data.catalog.metrics.map((m) => [m.code, m]));
  const units = unitChoices(t, data.catalog);
  const correctionsOf = (id: string) => data.corrections.filter((c) => c.measurementId === id);
  const tones = toneBreakdown(data.coverage);
  const reportHref = `/${org}/reports/measurement?project=${encodeURIComponent(projectKey)}`;
  return (
    <Panel id="measurement-panel" title={t("gate8.title")} description={t("gate8.description")}>
      <SummaryTable t={t} lines={lines} caption={t("summary.caption")} date={date} />
      {data.ticketing ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {data.ticketing.scanned === null
            ? t("ticketingSold", { sold: number(data.ticketing.sold) })
            : t("ticketing", {
                scanned: number(data.ticketing.scanned),
                sold: number(data.ticketing.sold),
              })}
        </p>
      ) : null}
      <a href={reportHref} className="text-text-13 text-accent-text underline">
        {t("gate8.openReport")}
      </a>

      <section aria-labelledby="figures-heading" className="flex flex-col gap-8">
        <h4 id="figures-heading" className="m-0 text-text-14 font-semibold">
          {t("figures.title")}
        </h4>
        {data.figures.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("figures.empty")}</p>
        ) : (
          <SimpleTable
            caption={t("figures.caption")}
            head={[
              t("fields.measuredOn"),
              t("fields.metric"),
              t("fields.value"),
              t("fields.source"),
              t("figures.recordedBy"),
              ...(canWrite ? [t("actions")] : []),
            ]}
            rows={data.figures.map((f) => {
              const metric = metricOf.get(f.metricCode);
              const history = correctionsOf(f.id);
              const label = metricLabel(t, f.metricCode);
              return [
                date(f.measuredOn),
                label,
                <span key="v" className="flex flex-col gap-2">
                  <span className={f.value === null ? "text-text-secondary" : undefined}>
                    {figureText(t, locale, f.value, f.unitCode)}
                  </span>
                  {history.map((c) => (
                    <span key={c.id} className="text-text-12 text-text-secondary">
                      {t("figures.historyEntry", {
                        kind: correctionLabel(t, c.kind),
                        before: figureText(t, locale, c.previousValue, c.previousUnitCode),
                        after: figureText(t, locale, c.value, c.unitCode),
                        name: c.correctedBy ?? t("system"),
                        date: date(c.correctedAt),
                      })}
                      {c.reason ? ` ${t("figures.historyReason", { reason: c.reason })}` : ""}
                    </span>
                  ))}
                </span>,
                <span key="s" className="flex flex-col gap-2">
                  <span>{sourceLabel(t, f.source)}</span>
                  {f.sourceUri ? (
                    <a
                      href={f.sourceUri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all text-text-12 text-accent-text underline"
                    >
                      {f.sourceReference ?? f.sourceUri}
                    </a>
                  ) : f.sourceReference ? (
                    <span className="text-text-12 text-text-secondary">{f.sourceReference}</span>
                  ) : null}
                </span>,
                f.recordedBy ?? t("system"),
                ...(canWrite && metric
                  ? [
                      <span key="a" className="flex flex-wrap gap-4">
                        <CorrectFigureDialog
                          org={org}
                          projectKey={projectKey}
                          units={units}
                          today={data.today}
                          figure={{
                            id: f.id,
                            metric: label,
                            dimension: metric.dimension,
                            measuredOn: f.measuredOn,
                            value: f.value,
                            unitCode: f.unitCode,
                            dayLabel: date(f.measuredOn),
                          }}
                        />
                        <WithdrawFigureDialog
                          org={org}
                          projectKey={projectKey}
                          figure={{ id: f.id, metric: label, dayLabel: date(f.measuredOn) }}
                        />
                      </span>,
                    ]
                  : []),
              ];
            })}
          />
        )}
        {canWrite ? (
          <FigureDialog
            org={org}
            projectKey={projectKey}
            today={data.today}
            units={units}
            metrics={data.catalog.metrics
              .filter((m) => !m.derived)
              .map((m) => ({
                value: m.code,
                label: metricLabel(t, m.code),
                dimension: m.dimension,
              }))}
          />
        ) : null}
      </section>

      <section aria-labelledby="coverage-heading" className="flex flex-col gap-8">
        <h4 id="coverage-heading" className="m-0 text-text-14 font-semibold">
          {t("coverage.title")}
        </h4>
        <p className="m-0 text-text-13 text-text-secondary">{t("coverage.description")}</p>
        {data.coverage.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("coverage.empty")}</p>
        ) : (
          <>
            <p className="m-0 text-text-13">
              {t("coverage.tones", {
                positive: tones.Positive,
                neutral: tones.Neutral,
                negative: tones.Negative,
                unrated: tones.Unrated,
              })}
            </p>
            <CoverageTable
              t={t}
              locale={locale}
              date={date}
              items={data.coverage}
              withdraw={
                canWrite
                  ? (item) => (
                      <WithdrawCoverageButton
                        org={org}
                        projectKey={projectKey}
                        itemId={item.id}
                        title={item.title}
                      />
                    )
                  : null
              }
            />
          </>
        )}
        {canWrite ? (
          <CoverageDialog
            org={org}
            projectKey={projectKey}
            today={data.today}
            mediums={COVERAGE_MEDIUMS.map((m) => ({ value: m, label: mediumLabel(t, m) }))}
            tones={COVERAGE_TONES.map((tone) => ({ value: tone, label: toneLabel(t, tone) }))}
          />
        ) : null}
      </section>

      {attested ? (
        <p className="m-0 text-text-13 text-success-text">{t("gate8.attested")}</p>
      ) : canAttest ? (
        <AttestButton
          org={org}
          projectKey={projectKey}
          kind="measurement"
          note={t("gate8.attestNote", {
            met: lines.filter((l) => l.outcome === "Met").length,
            count: lines.filter((l) => l.outcome !== null).length,
          })}
          label={t("gate8.attest")}
          success={t("gate8.attested")}
        />
      ) : null}
    </Panel>
  );
}
