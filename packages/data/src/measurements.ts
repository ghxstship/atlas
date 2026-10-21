import type { Database, XosClient } from "./client.ts";
import { blankToNull, deletedNow, insertedId, readRows, touched } from "./commercial-common.ts";
import { Constants } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Project measurement (A98, finding A65-030, Section 4.10, migrations 1550 and 1551): the objectives recorded at gate 1,
 * the sustainability, audience and sentiment figures measured against them, the earned media coverage gate 8 counts,
 * and the summary that compares them. Reads go through row level security (projects.gate.read on the project); writes
 * need projects.gate.evidence.write, and the database guards decide every refusal: units of the metric's dimension,
 * days on the project's calendar, objectives locked to gate approvers once gate 1 is passed, and a reason for every
 * correction, which the correction ledger keeps.
 *
 * A figure that was not measured is `null` everywhere here and is shown as Unmeasured, never as zero. Totals cover the
 * measured figures only, with the unmeasured count beside them (Section 3.7: aggregates of blanks are blank).
 */

type Enums = Database["app"]["Enums"];
export type MeasurementSource = Enums["measurement_source"];
export type ObjectiveDirection = Enums["objective_direction"];
export type CorrectionKind = Enums["measurement_correction_kind"];
export type CoverageMedium = Enums["coverage_medium"];
export type CoverageTone = Enums["coverage_tone"];
export type Dimension = "Mass" | "Volume" | "Energy" | "Emissions" | "Count" | "Percent";
export type MetricFamily = "Sustainability" | "Audience" | "Earned Media" | "Sentiment";
export type Aggregation = "Sum" | "Latest";
export type Outcome = "Met" | "Not Met" | "Incomplete" | "Unmeasured";
/** The person's units (locale.units). */
export type UnitPreference = "imperial" | "metric";

export const MEASUREMENT_SOURCES: readonly MeasurementSource[] =
  Constants.app.Enums.measurement_source;
export const OBJECTIVE_DIRECTIONS: readonly ObjectiveDirection[] =
  Constants.app.Enums.objective_direction;
export const COVERAGE_MEDIUMS: readonly CoverageMedium[] = Constants.app.Enums.coverage_medium;
export const COVERAGE_TONES: readonly CoverageTone[] = Constants.app.Enums.coverage_tone;
export const METRIC_FAMILIES: readonly MetricFamily[] = [
  "Sustainability",
  "Audience",
  "Earned Media",
  "Sentiment",
];
export const OUTCOMES: readonly Outcome[] = ["Met", "Not Met", "Incomplete", "Unmeasured"];

/** The canon criteria the measurement evidences (Bible tab 06). */
export const OBJECTIVES_CRITERION = "G1.OBJECTIVES_STATED";
export const MEASUREMENT_CRITERION = "G8.MEASUREMENT_REPORTED";

/** The evidence URI that names a project's objectives or its measurement report on the evidence spine. */
export function measurementEvidenceUri(kind: "objectives" | "measurement", projectId: string) {
  return `urn:xpms:project-${kind}:${projectId}`;
}

// Catalog ------------------------------------------------------------------------------------------------------------

export interface MeasurementUnit {
  readonly code: string;
  readonly dimension: Dimension;
  /** Base units in one of this unit; exact. */
  readonly factor: number;
  readonly system: "Metric" | "Imperial" | "Either";
  readonly isDisplay: boolean;
  readonly ordinal: number;
}

export interface MeasurementMetric {
  readonly code: string;
  readonly family: MetricFamily;
  readonly dimension: Dimension;
  readonly baseUnit: string;
  readonly aggregation: Aggregation;
  /** Computed from the coverage records, never entered. */
  readonly derived: boolean;
  readonly lowerBound: number | null;
  readonly upperBound: number | null;
  /** The canon metric (xpms.dim_metric) that benchmarks the figure, when canon states one. */
  readonly canon: {
    readonly domain: string;
    readonly item: string;
    readonly value: string;
    readonly qualifier: string | null;
  } | null;
  /** The Bible sustainability tags the figure is reported against. */
  readonly tags: readonly { readonly id: string; readonly tag: string }[];
  readonly ordinal: number;
}

export interface MeasurementCatalog {
  readonly metrics: readonly MeasurementMetric[];
  readonly units: readonly MeasurementUnit[];
}

/** The metrics, their units and their sustainability tags, in display order. */
export async function listMeasurementCatalog(db: XosClient): Promise<Result<MeasurementCatalog>> {
  const [metrics, units, tags] = await Promise.all([
    db
      .from("measurement_metrics")
      .select(
        "metric_code, family, dimension, base_unit_code, aggregation, is_derived, lower_bound, upper_bound, canon_domain, canon_item, canon_value_numeric, canon_value_text, canon_qualifier, ordinal",
      )
      .order("ordinal"),
    db
      .from("measurement_units")
      .select("unit_code, dimension, factor_to_base, unit_system, is_display, ordinal")
      .order("ordinal"),
    db.from("measurement_metric_tags").select("metric_code, tag_id, tag").order("tag_id"),
  ]);
  const error = metrics.error ?? units.error ?? tags.error;
  if (error) return fail(toDataError(error));
  const tagsOf = new Map<string, { id: string; tag: string }[]>();
  for (const t of tags.data ?? []) {
    const list = tagsOf.get(t.metric_code ?? "") ?? [];
    list.push({ id: t.tag_id ?? "", tag: t.tag ?? "" });
    tagsOf.set(t.metric_code ?? "", list);
  }
  return ok({
    metrics: (metrics.data ?? []).map((m) => ({
      code: m.metric_code ?? "",
      family: m.family as MetricFamily,
      dimension: m.dimension as Dimension,
      baseUnit: m.base_unit_code ?? "",
      aggregation: m.aggregation as Aggregation,
      derived: m.is_derived === true,
      lowerBound: m.lower_bound,
      upperBound: m.upper_bound,
      canon:
        m.canon_domain && m.canon_item
          ? {
              domain: m.canon_domain,
              item: m.canon_item,
              value:
                m.canon_value_numeric !== null
                  ? String(m.canon_value_numeric)
                  : (m.canon_value_text ?? ""),
              qualifier: m.canon_qualifier,
            }
          : null,
      tags: tagsOf.get(m.metric_code ?? "") ?? [],
      ordinal: m.ordinal ?? 0,
    })),
    units: (units.data ?? []).map((u) => ({
      code: u.unit_code ?? "",
      dimension: u.dimension as Dimension,
      factor: Number(u.factor_to_base),
      system: u.unit_system as MeasurementUnit["system"],
      isDisplay: u.is_display === true,
      ordinal: u.ordinal ?? 0,
    })),
  });
}

// Units --------------------------------------------------------------------------------------------------------------

/** The units a figure of a dimension may be entered in, in display order. */
export function unitsOf(
  units: readonly MeasurementUnit[],
  dimension: Dimension,
): MeasurementUnit[] {
  return units.filter((u) => u.dimension === dimension);
}

/**
 * The unit a report shows a dimension in for the person's units (locale.units): kg or lb, l or gal, and kWh, kg CO2e,
 * count and percent for both. Falls back to the dimension's base unit.
 */
export function displayUnitFor(
  units: readonly MeasurementUnit[],
  dimension: Dimension,
  preference: UnitPreference,
): MeasurementUnit {
  const system = preference === "metric" ? "Metric" : "Imperial";
  const own = units.filter((u) => u.dimension === dimension);
  const shown = own.find((u) => u.isDisplay && (u.system === system || u.system === "Either"));
  const base = own.find((u) => u.factor === 1);
  if (shown) return shown;
  if (base) return base;
  throw new Error(`No unit for ${dimension}`);
}

/** A figure in another unit of the same dimension; null stays null (Unmeasured). */
export function convertFigure(
  value: number | null,
  from: MeasurementUnit,
  to: MeasurementUnit,
): number | null {
  if (from.dimension !== to.dimension) {
    throw new Error(
      `Cannot convert ${from.code} (${from.dimension}) to ${to.code} (${to.dimension})`,
    );
  }
  if (value === null) return null;
  if (from.code === to.code) return value;
  return (value * from.factor) / to.factor;
}

/** A base-unit figure from the summary in the person's display unit; null stays null. */
export function inDisplayUnit(
  base: number | null,
  dimension: Dimension,
  units: readonly MeasurementUnit[],
  preference: UnitPreference,
): { readonly value: number | null; readonly unit: MeasurementUnit } {
  const unit = displayUnitFor(units, dimension, preference);
  return { value: base === null ? null : base / unit.factor, unit };
}

// Objectives ---------------------------------------------------------------------------------------------------------

export interface ProjectObjective {
  readonly id: string;
  readonly projectId: string;
  readonly metricCode: string;
  readonly direction: ObjectiveDirection;
  readonly targetValue: number;
  readonly unitCode: string;
  readonly note: string | null;
  readonly setBy: string | null;
  readonly updatedAt: string;
}

/** The live objectives of a project. */
export async function listProjectObjectives(
  db: XosClient,
  projectId: string,
): Promise<Result<ProjectObjective[]>> {
  return readRows(
    db
      .from("project_objectives")
      .select(
        "id, project_id, metric_code, direction, target_value, unit_code, note, updated_at, setter:people!project_objectives_updated_by_fkey(full_name)",
      )
      .eq("project_id", projectId)
      .is("deleted_at", null),
    (r: {
      id: string;
      project_id: string;
      metric_code: string;
      direction: ObjectiveDirection;
      target_value: number;
      unit_code: string;
      note: string | null;
      updated_at: string;
      setter: { full_name: string | null } | null;
    }) => ({
      id: r.id,
      projectId: r.project_id,
      metricCode: r.metric_code,
      direction: r.direction,
      targetValue: Number(r.target_value),
      unitCode: r.unit_code,
      note: r.note,
      setBy: r.setter?.full_name ?? null,
      updatedAt: r.updated_at,
    }),
  );
}

export interface ObjectiveInput {
  /** The live objective being changed, or null to set a new one. */
  readonly id: string | null;
  readonly projectId: string;
  readonly metricCode: string;
  readonly direction: ObjectiveDirection;
  readonly targetValue: number;
  readonly unitCode: string;
  readonly note?: string | null;
}

/** Sets an objective, or changes the live one; after gate 1 only a gate approver may (project_objectives_locked). */
export async function saveProjectObjective(
  db: XosClient,
  input: ObjectiveInput,
): Promise<Result<{ id: string }>> {
  const fields = {
    direction: input.direction,
    target_value: input.targetValue,
    unit_code: input.unitCode,
    note: blankToNull(input.note),
  };
  if (input.id !== null) {
    const id = input.id;
    const result = await touched(
      db.from("project_objectives").update(fields).eq("id", id).select("id"),
    );
    return result.ok ? ok({ id }) : result;
  }
  return insertedId(
    db
      .from("project_objectives")
      .insert({
        project_id: input.projectId,
        metric_code: input.metricCode,
        ...fields,
      } as Database["app"]["Tables"]["project_objectives"]["Insert"])
      .select("id")
      .single(),
  );
}

/** Withdraws an objective; it stops being measured against. */
export async function withdrawProjectObjective(
  db: XosClient,
  id: string,
  now: Date = new Date(),
): Promise<Result<null>> {
  return touched(db.from("project_objectives").update(deletedNow(now)).eq("id", id).select("id"));
}

// Measurements -------------------------------------------------------------------------------------------------------

export interface ProjectMeasurement {
  readonly id: string;
  readonly projectId: string;
  readonly metricCode: string;
  readonly measuredOn: string;
  /** Null when the figure was not measured (Unmeasured). */
  readonly value: number | null;
  readonly unitCode: string | null;
  readonly source: MeasurementSource;
  readonly sourceReference: string | null;
  readonly sourceUri: string | null;
  readonly note: string | null;
  readonly recordedBy: string | null;
  readonly recordedAt: string;
}

/** The live figures of a project, newest day first. */
export async function listProjectMeasurements(
  db: XosClient,
  projectId: string,
): Promise<Result<ProjectMeasurement[]>> {
  return readRows(
    db
      .from("project_measurements")
      .select(
        "id, project_id, metric_code, measured_on, value, unit_code, source, source_reference, source_uri, note, created_at, recorder:people!project_measurements_created_by_fkey(full_name)",
      )
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("measured_on", { ascending: false })
      .order("created_at", { ascending: false }),
    (r: {
      id: string;
      project_id: string;
      metric_code: string;
      measured_on: string;
      value: number | null;
      unit_code: string | null;
      source: MeasurementSource;
      source_reference: string | null;
      source_uri: string | null;
      note: string | null;
      created_at: string;
      recorder: { full_name: string | null } | null;
    }) => ({
      id: r.id,
      projectId: r.project_id,
      metricCode: r.metric_code,
      measuredOn: r.measured_on,
      value: r.value === null ? null : Number(r.value),
      unitCode: r.unit_code,
      source: r.source,
      sourceReference: r.source_reference,
      sourceUri: r.source_uri,
      note: r.note,
      recordedBy: r.recorder?.full_name ?? null,
      recordedAt: r.created_at,
    }),
  );
}

export interface MeasurementInput {
  readonly projectId: string;
  readonly metricCode: string;
  /** Day on the project's calendar; the database takes today there when null. */
  readonly measuredOn: string | null;
  /** Null records that the figure was not measured. */
  readonly value: number | null;
  readonly unitCode: string | null;
  readonly source?: MeasurementSource;
  readonly sourceReference?: string | null;
  readonly sourceUri?: string | null;
  readonly note?: string | null;
}

/** Records a figure, or that it was not measured (value null). */
export async function recordProjectMeasurement(
  db: XosClient,
  input: MeasurementInput,
): Promise<Result<{ id: string }>> {
  return insertedId(
    db
      .from("project_measurements")
      .insert({
        project_id: input.projectId,
        metric_code: input.metricCode,
        ...(input.measuredOn ? { measured_on: input.measuredOn } : {}),
        value: input.value,
        unit_code: input.value === null ? null : input.unitCode,
        source: input.source ?? "Manual",
        source_reference: blankToNull(input.sourceReference),
        source_uri: blankToNull(input.sourceUri),
        note: blankToNull(input.note),
      } as Database["app"]["Tables"]["project_measurements"]["Insert"])
      .select("id")
      .single(),
  );
}

export interface CorrectionInput {
  readonly id: string;
  readonly measuredOn: string;
  readonly value: number | null;
  readonly unitCode: string | null;
  /** Why the figure is corrected; the correction ledger keeps it. */
  readonly reason: string;
}

/** Corrects a figure's value, unit or day; the database writes the change and the reason to the ledger. */
export async function correctProjectMeasurement(
  db: XosClient,
  input: CorrectionInput,
): Promise<Result<null>> {
  return touched(
    db
      .from("project_measurements")
      .update({
        measured_on: input.measuredOn,
        value: input.value,
        unit_code: input.value === null ? null : input.unitCode,
        correction_reason: input.reason.trim(),
      })
      .eq("id", input.id)
      .select("id"),
  );
}

/** Withdraws a figure, with an optional reason; the ledger records the withdrawal. */
export async function withdrawProjectMeasurement(
  db: XosClient,
  input: { readonly id: string; readonly reason?: string | null },
  now: Date = new Date(),
): Promise<Result<null>> {
  return touched(
    db
      .from("project_measurements")
      .update({ ...deletedNow(now), correction_reason: blankToNull(input.reason) })
      .eq("id", input.id)
      .select("id"),
  );
}

export interface MeasurementCorrection {
  readonly id: string;
  readonly measurementId: string;
  readonly kind: CorrectionKind;
  readonly previousValue: number | null;
  readonly previousUnitCode: string | null;
  readonly previousMeasuredOn: string;
  readonly value: number | null;
  readonly unitCode: string | null;
  readonly measuredOn: string;
  readonly reason: string | null;
  readonly correctedBy: string | null;
  readonly correctedAt: string;
}

/** The corrections, withdrawals and restores of a project's figures, oldest first. */
export async function listMeasurementCorrections(
  db: XosClient,
  projectId: string,
): Promise<Result<MeasurementCorrection[]>> {
  return readRows(
    db
      .from("project_measurement_corrections")
      .select(
        "id, project_measurement_id, correction_kind, previous_value, previous_unit_code, previous_measured_on, value, unit_code, measured_on, reason, created_at, corrector:people!project_measurement_corrections_created_by_fkey(full_name), measurement:project_measurements!inner(project_id)",
      )
      .eq("measurement.project_id", projectId)
      .order("created_at"),
    (r: {
      id: string;
      project_measurement_id: string;
      correction_kind: CorrectionKind;
      previous_value: number | null;
      previous_unit_code: string | null;
      previous_measured_on: string;
      value: number | null;
      unit_code: string | null;
      measured_on: string;
      reason: string | null;
      created_at: string;
      corrector: { full_name: string | null } | null;
    }) => ({
      id: r.id,
      measurementId: r.project_measurement_id,
      kind: r.correction_kind,
      previousValue: r.previous_value === null ? null : Number(r.previous_value),
      previousUnitCode: r.previous_unit_code,
      previousMeasuredOn: r.previous_measured_on,
      value: r.value === null ? null : Number(r.value),
      unitCode: r.unit_code,
      measuredOn: r.measured_on,
      reason: r.reason,
      correctedBy: r.corrector?.full_name ?? null,
      correctedAt: r.created_at,
    }),
  );
}

// Earned media -------------------------------------------------------------------------------------------------------

export interface EarnedMediaItem {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly outlet: string;
  readonly medium: CoverageMedium;
  readonly publishedOn: string;
  readonly url: string | null;
  /** Null when the source reports no reach (Unmeasured). */
  readonly reach: number | null;
  /** Null until rated. */
  readonly tone: CoverageTone | null;
  readonly source: MeasurementSource;
  readonly sourceReference: string | null;
  readonly note: string | null;
  readonly recordedBy: string | null;
}

/** The live coverage of a project, newest first. */
export async function listEarnedMediaItems(
  db: XosClient,
  projectId: string,
): Promise<Result<EarnedMediaItem[]>> {
  return readRows(
    db
      .from("earned_media_items")
      .select(
        "id, project_id, title, outlet, medium, published_on, url, reach, tone, source, source_reference, note, recorder:people!earned_media_items_created_by_fkey(full_name)",
      )
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("published_on", { ascending: false })
      .order("created_at", { ascending: false }),
    (r: {
      id: string;
      project_id: string;
      title: string;
      outlet: string;
      medium: CoverageMedium;
      published_on: string;
      url: string | null;
      reach: number | null;
      tone: CoverageTone | null;
      source: MeasurementSource;
      source_reference: string | null;
      note: string | null;
      recorder: { full_name: string | null } | null;
    }) => ({
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      outlet: r.outlet,
      medium: r.medium,
      publishedOn: r.published_on,
      url: r.url,
      reach: r.reach,
      tone: r.tone,
      source: r.source,
      sourceReference: r.source_reference,
      note: r.note,
      recordedBy: r.recorder?.full_name ?? null,
    }),
  );
}

export interface EarnedMediaInput {
  readonly projectId: string;
  readonly title: string;
  readonly outlet: string;
  readonly medium: CoverageMedium;
  readonly publishedOn: string;
  readonly url?: string | null;
  readonly reach?: number | null;
  readonly tone?: CoverageTone | null;
  readonly source?: MeasurementSource;
  readonly sourceReference?: string | null;
  readonly note?: string | null;
}

/** Records a piece of coverage; a link already recorded on the project is a conflict. */
export async function recordEarnedMediaItem(
  db: XosClient,
  input: EarnedMediaInput,
): Promise<Result<{ id: string }>> {
  return insertedId(
    db
      .from("earned_media_items")
      .insert({
        project_id: input.projectId,
        title: input.title.trim(),
        outlet: input.outlet.trim(),
        medium: input.medium,
        published_on: input.publishedOn,
        url: blankToNull(input.url),
        reach: input.reach ?? null,
        tone: input.tone ?? null,
        source: input.source ?? "Manual",
        source_reference: blankToNull(input.sourceReference),
        note: blankToNull(input.note),
      } as Database["app"]["Tables"]["earned_media_items"]["Insert"])
      .select("id")
      .single(),
  );
}

/** Withdraws a piece of coverage recorded in error; it can be restored from Trash. */
export async function withdrawEarnedMediaItem(
  db: XosClient,
  id: string,
  now: Date = new Date(),
): Promise<Result<null>> {
  return touched(db.from("earned_media_items").update(deletedNow(now)).eq("id", id).select("id"));
}

/** How the coverage reads: pieces per tone, and those not yet rated. */
export function toneBreakdown(
  items: readonly Pick<EarnedMediaItem, "tone">[],
): Readonly<Record<CoverageTone | "Unrated", number>> {
  const out: Record<CoverageTone | "Unrated", number> = {
    Positive: 0,
    Neutral: 0,
    Negative: 0,
    Unrated: 0,
  };
  for (const i of items) out[i.tone ?? "Unrated"] += 1;
  return out;
}

// Summary ------------------------------------------------------------------------------------------------------------

export interface MeasurementSummaryRow {
  readonly projectId: string;
  readonly metricCode: string;
  readonly family: MetricFamily;
  readonly dimension: Dimension;
  readonly aggregation: Aggregation;
  readonly objectiveId: string | null;
  readonly direction: ObjectiveDirection | null;
  readonly targetValue: number | null;
  readonly targetUnitCode: string | null;
  /** Target in the metric's base unit. */
  readonly targetBase: number | null;
  readonly measuredCount: number;
  readonly unmeasuredCount: number;
  /** Total or latest figure in the base unit; null when nothing was measured. */
  readonly measuredBase: number | null;
  readonly lastMeasuredOn: string | null;
  /** Null without an objective. */
  readonly outcome: Outcome | null;
}

/** Objectives against figures per project and metric, for one project or every readable one of the org. */
export async function listMeasurementSummary(
  db: XosClient,
  scope: { readonly orgId: string; readonly projectId: string | null },
): Promise<Result<MeasurementSummaryRow[]>> {
  let query = db
    .from("project_measurement_summary")
    .select(
      "project_id, metric_code, family, dimension, aggregation, objective_id, direction, target_value, target_unit_code, target_base, measured_count, unmeasured_count, measured_base, last_measured_on, outcome",
    )
    .eq("org_id", scope.orgId);
  if (scope.projectId !== null) query = query.eq("project_id", scope.projectId);
  const num = (v: number | null) => (v === null ? null : Number(v));
  return readRows(query, (r) => ({
    projectId: r.project_id ?? "",
    metricCode: r.metric_code ?? "",
    family: r.family as MetricFamily,
    dimension: r.dimension as Dimension,
    aggregation: r.aggregation as Aggregation,
    objectiveId: r.objective_id,
    direction: r.direction,
    targetValue: num(r.target_value),
    targetUnitCode: r.target_unit_code,
    targetBase: num(r.target_base),
    measuredCount: r.measured_count ?? 0,
    unmeasuredCount: r.unmeasured_count ?? 0,
    measuredBase: num(r.measured_base),
    lastMeasuredOn: r.last_measured_on,
    outcome: r.outcome as Outcome | null,
  }));
}

/**
 * Every metric of the catalog for one project, in display order, with its summary row; a metric with neither an
 * objective nor a figure gets an empty row that reads Unmeasured, so a missing figure is never left out or shown as 0.
 */
export function projectMetricRows(
  metrics: readonly MeasurementMetric[],
  rows: readonly MeasurementSummaryRow[],
  projectId: string,
): { readonly metric: MeasurementMetric; readonly row: MeasurementSummaryRow }[] {
  const byMetric = new Map(
    rows.filter((r) => r.projectId === projectId).map((r) => [r.metricCode, r]),
  );
  return [...metrics]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((metric) => ({
      metric,
      row: byMetric.get(metric.code) ?? {
        projectId,
        metricCode: metric.code,
        family: metric.family,
        dimension: metric.dimension,
        aggregation: metric.aggregation,
        objectiveId: null,
        direction: null,
        targetValue: null,
        targetUnitCode: null,
        targetBase: null,
        measuredCount: 0,
        unmeasuredCount: 0,
        measuredBase: null,
        lastMeasuredOn: null,
        outcome: null,
      },
    }));
}

export interface ProjectRollup {
  readonly projectId: string;
  readonly objectives: number;
  readonly outcomes: Readonly<Record<Outcome, number>>;
}

/** Per project, how many objectives it set and how they stand (the org rollup). */
export function rollupByProject(rows: readonly MeasurementSummaryRow[]): ProjectRollup[] {
  const out = new Map<string, { objectives: number; outcomes: Record<Outcome, number> }>();
  for (const r of rows) {
    const entry = out.get(r.projectId) ?? {
      objectives: 0,
      outcomes: { Met: 0, "Not Met": 0, Incomplete: 0, Unmeasured: 0 },
    };
    if (r.objectiveId !== null && r.outcome !== null) {
      entry.objectives += 1;
      entry.outcomes[r.outcome] += 1;
    }
    out.set(r.projectId, entry);
  }
  return [...out].map(([projectId, v]) => ({ projectId, ...v }));
}

export interface MetricRollup {
  readonly metricCode: string;
  /**
   * Across projects, in the base unit: the total of a Sum metric, or the mean of the projects' latest figures for a
   * Latest metric. Null when no project measured it.
   */
  readonly value: number | null;
  readonly projectsMeasured: number;
  /** Projects with an objective or a record for the metric but no measured figure. */
  readonly projectsUnmeasured: number;
  /** Projects whose measured figures leave some unmeasured beside them. */
  readonly projectsPartial: number;
}

/** Per metric, the org-wide figure over the projects that measured it, NULL-aware (the org rollup). */
export function rollupByMetric(
  metrics: readonly MeasurementMetric[],
  rows: readonly MeasurementSummaryRow[],
): MetricRollup[] {
  return [...metrics]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((metric) => {
      const own = rows.filter((r) => r.metricCode === metric.code);
      const measured = own.filter((r) => r.measuredCount > 0 && r.measuredBase !== null);
      const sum = measured.reduce((total, r) => total + (r.measuredBase ?? 0), 0);
      return {
        metricCode: metric.code,
        value:
          measured.length === 0
            ? null
            : metric.aggregation === "Latest"
              ? sum / measured.length
              : sum,
        projectsMeasured: measured.length,
        projectsUnmeasured: own.filter((r) => r.measuredCount === 0).length,
        projectsPartial: measured.filter((r) => r.unmeasuredCount > 0).length,
      };
    });
}
