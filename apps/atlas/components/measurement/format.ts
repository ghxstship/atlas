import type {
  CorrectionKind,
  CoverageMedium,
  CoverageTone,
  MeasurementSource,
  MetricFamily,
  ObjectiveDirection,
  Outcome,
} from "@xos/data/measurements";

/**
 * Copy keys and number formatting for the measurement pages (A98), shared by the server views and the client forms.
 * Every label comes from the `measurement` namespace; a figure nobody measured reads Unmeasured, never 0
 * (Section 4.10, Section 3.7).
 */

/** A translator over the `measurement` namespace with keys computed at runtime. */
export type MeasurementT = (key: string, values?: Record<string, string | number>) => string;

const FAMILY: Record<MetricFamily, string> = {
  Sustainability: "sustainability",
  Audience: "audience",
  "Earned Media": "earnedMedia",
  Sentiment: "sentiment",
};
const DIRECTION: Record<ObjectiveDirection, string> = {
  "At Least": "atLeast",
  "At Most": "atMost",
};
const OUTCOME: Record<Outcome, string> = {
  Met: "met",
  "Not Met": "notMet",
  Incomplete: "incomplete",
  Unmeasured: "unmeasured",
};
const SOURCE: Record<MeasurementSource, string> = {
  Manual: "manual",
  Import: "import",
  Integration: "integration",
};
const CORRECTION: Record<CorrectionKind, string> = {
  Corrected: "corrected",
  Withdrawn: "withdrawn",
  Restored: "restored",
};

export const familyLabel = (t: MeasurementT, f: MetricFamily) => t(`families.${FAMILY[f]}`);
export const directionLabel = (t: MeasurementT, d: ObjectiveDirection) =>
  t(`directions.${DIRECTION[d]}`);
export const outcomeLabel = (t: MeasurementT, o: Outcome) => t(`outcomes.${OUTCOME[o]}`);
export const sourceLabel = (t: MeasurementT, s: MeasurementSource) => t(`sources.${SOURCE[s]}`);
export const mediumLabel = (t: MeasurementT, m: CoverageMedium) => t(`mediums.${m.toLowerCase()}`);
export const toneLabel = (t: MeasurementT, tone: CoverageTone | null) =>
  tone === null ? t("unrated") : t(`tones.${tone.toLowerCase()}`);
export const correctionLabel = (t: MeasurementT, k: CorrectionKind) =>
  t(`corrections.${CORRECTION[k]}`);
export const metricLabel = (t: MeasurementT, code: string) => t(`metrics.${code}`);
export const unitName = (t: MeasurementT, code: string) => t(`unitNames.${code}`);

/** The tone of an outcome tag. */
export function outcomeTone(o: Outcome | null): "success" | "danger" | "warning" | "neutral" {
  if (o === "Met") return "success";
  if (o === "Not Met") return "danger";
  if (o === "Incomplete") return "warning";
  return "neutral";
}

/** A number for a figure: whole for counts, up to two decimals otherwise. */
export function figureNumber(locale: string, value: number, unitCode: string): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: unitCode === "count" ? 0 : 2,
  }).format(value);
}

/** A figure with its unit, or Unmeasured when it is null. */
export function figureText(
  t: MeasurementT,
  locale: string,
  value: number | null,
  unitCode: string | null,
): string {
  if (value === null || unitCode === null) return t("unmeasured");
  return t(`units.${unitCode}`, { value: figureNumber(locale, value, unitCode) });
}
