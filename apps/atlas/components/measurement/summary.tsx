import {
  inDisplayUnit,
  projectMetricRows,
  type MeasurementCatalog,
  type MeasurementSummaryRow,
  type UnitPreference,
} from "@xos/data/measurements";
import { SimpleTable } from "@/components/finance/figures";
import {
  directionLabel,
  familyLabel,
  figureText,
  metricLabel,
  outcomeLabel,
  outcomeTone,
  type MeasurementT,
} from "./format";

/**
 * Objectives against figures for one project (A98, Section 4.10), as the gate 8 review and the measurement report
 * show it: every metric of the catalog in order, the target and the measured figure both in the person's units
 * (locale.units) so they compare directly, the target as it was set when that unit differs, the unmeasured count
 * beside a total, and the outcome. A metric nothing measured reads Unmeasured, never 0.
 */

export interface SummaryLine {
  readonly metricCode: string;
  readonly metric: string;
  readonly family: string;
  readonly objective: string | null;
  /** The target as it was set, when its unit differs from the display unit. */
  readonly setAs: string | null;
  readonly measured: string;
  readonly unmeasured: number;
  readonly measuredCount: number;
  readonly outcome: MeasurementSummaryRow["outcome"];
  readonly outcomeText: string;
  readonly lastMeasuredOn: string | null;
  readonly benchmark: string | null;
  readonly tags: readonly string[];
}

export function summaryLines(
  t: MeasurementT,
  locale: string,
  catalog: MeasurementCatalog,
  rows: readonly MeasurementSummaryRow[],
  projectId: string,
  preference: UnitPreference,
): SummaryLine[] {
  return projectMetricRows(catalog.metrics, rows, projectId).map(({ metric, row }) => {
    const target = inDisplayUnit(row.targetBase, metric.dimension, catalog.units, preference);
    const measured = inDisplayUnit(row.measuredBase, metric.dimension, catalog.units, preference);
    const objective =
      row.direction === null || target.value === null
        ? null
        : `${directionLabel(t, row.direction)} ${figureText(t, locale, target.value, target.unit.code)}`;
    const setAs =
      objective !== null && row.targetUnitCode !== null && row.targetUnitCode !== target.unit.code
        ? figureText(t, locale, row.targetValue, row.targetUnitCode)
        : null;
    return {
      metricCode: metric.code,
      metric: metricLabel(t, metric.code),
      family: familyLabel(t, metric.family),
      objective,
      setAs,
      measured: figureText(t, locale, measured.value, measured.unit.code),
      unmeasured: row.unmeasuredCount,
      measuredCount: row.measuredCount,
      outcome: row.outcome,
      outcomeText: row.outcome === null ? t("noObjective") : outcomeLabel(t, row.outcome),
      lastMeasuredOn: row.lastMeasuredOn,
      benchmark: metric.canon
        ? t("benchmark", { value: metric.canon.value, item: metric.canon.item })
        : null,
      tags: metric.tags.map((tag) => tag.tag),
    };
  });
}

/** The header and CSV cells of the per-project summary, shared by the report export. */
export function summaryHeader(t: MeasurementT): string[] {
  return [
    t("summary.family"),
    t("summary.metric"),
    t("summary.objective"),
    t("summary.measured"),
    t("summary.unmeasuredCount"),
    t("summary.outcome"),
  ];
}

export function summaryCsv(lines: readonly SummaryLine[]): string[][] {
  return lines.map((l) => [
    l.family,
    l.metric,
    l.objective ?? "",
    l.measured,
    String(l.unmeasured),
    l.outcomeText,
  ]);
}

const DOT = {
  neutral: "bg-text-tertiary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
} as const;

/**
 * The outcome as a status word with a colored dot, in the markup of @xos/ui's Tag. Server-rendered on its own so the
 * report and the gate panels import nothing from @xos/ui into the route's client JavaScript (ADR 0027).
 */
export function OutcomeTag({
  outcome,
  children,
}: {
  outcome: SummaryLine["outcome"];
  children: string;
}) {
  return (
    <span className="inline-flex h-(--ui-tag) items-center gap-4 whitespace-nowrap rounded-chip bg-bg-hover px-6 text-text-12 font-medium text-text-secondary forced-colors:border">
      <span
        aria-hidden="true"
        className={`size-(--ui-dot) flex-none rounded-full ${DOT[outcomeTone(outcome)]}`}
      />
      {children}
    </span>
  );
}

export function SummaryTable({
  t,
  lines,
  caption,
  date,
}: {
  t: MeasurementT;
  lines: readonly SummaryLine[];
  caption: string;
  date: (iso: string | null) => string;
}) {
  return (
    <SimpleTable
      caption={caption}
      head={[
        t("summary.metric"),
        t("summary.objective"),
        t("summary.measured"),
        t("summary.outcome"),
        t("summary.lastMeasured"),
      ]}
      rows={lines.map((l) => [
        <span key="m" className="flex flex-col gap-2">
          <span className="font-medium text-text-primary">{l.metric}</span>
          <span className="text-text-12 text-text-secondary">{l.family}</span>
          {l.benchmark ? (
            <span className="text-text-12 text-text-secondary">{l.benchmark}</span>
          ) : null}
          {l.tags.length > 0 ? (
            <span className="text-text-12 text-text-secondary">
              {t("tags", { tags: l.tags.join(", ") })}
            </span>
          ) : null}
        </span>,
        l.objective === null ? (
          <span key="o" className="text-text-secondary">
            {t("noObjective")}
          </span>
        ) : (
          <span key="o" className="flex flex-col gap-2">
            <span>{l.objective}</span>
            {l.setAs ? (
              <span className="text-text-12 text-text-secondary">
                {t("summary.setAs", { target: l.setAs })}
              </span>
            ) : null}
          </span>
        ),
        <span key="v" className="flex flex-col gap-2">
          <span className={l.measuredCount === 0 ? "text-text-secondary" : undefined}>
            {l.measured}
          </span>
          {l.unmeasured > 0 ? (
            <span className="text-text-12 text-text-secondary">
              {t("summary.unmeasuredBeside", { count: l.unmeasured })}
            </span>
          ) : null}
        </span>,
        l.outcome === null ? (
          <span key="r" className="text-text-secondary">
            {l.outcomeText}
          </span>
        ) : (
          <OutcomeTag key="r" outcome={l.outcome}>
            {l.outcomeText}
          </OutcomeTag>
        ),
        date(l.lastMeasuredOn),
      ])}
    />
  );
}
