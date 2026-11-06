import type { CellIssue, ImportDestination, TargetLookups } from "./import-worker.ts";

/** What a target's row check shares with app-wide validation in validateRow (import-worker.ts). */
export interface RowCheck {
  readonly orgId: string;
  readonly destination: ImportDestination;
  readonly lookups: TargetLookups;
  readonly text: (field: string) => string;
  readonly set: (
    field: string,
    check: (v: string) => Promise<unknown> | unknown,
    issue: string,
    column?: string,
  ) => Promise<void>;
  readonly columnOf: (field: string) => number;
  readonly values: Record<string, unknown>;
  readonly issues: CellIssue[];
}

/**
 * The procurement_needs and po_lines import targets (B11, G-106, 6537), loaded only for them, because import-run's boot
 * has a ceiling.
 */

/** The longest text of the B11 targets, by target (the column checks of 0331 and 6531). */
const MATERIAL_MAX_LENGTH: Readonly<Record<string, number>> = {
  description: 500,
  note: 1000,
};

const QUANTITY = /^\d+(?:[.,]\d+)?$/;
const LOCAL_DATE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?)?$/;

function positiveQuantity(value: string): number | null {
  const v = value.trim();
  if (!QUANTITY.test(v)) return null;
  const n = Number(v.replace(",", "."));
  return n > 0 ? n : null;
}

/** The offset of a time zone at an instant, in milliseconds. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(utcMs));
  const of = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (
    Date.UTC(of("year"), of("month") - 1, of("day"), of("hour"), of("minute"), of("second")) - utcMs
  );
}

/** A date or date and time typed in a project's time zone, as an instant; null when it does not read. */
export function zonedInstant(value: string, timeZone: string): string | null {
  const hit = LOCAL_DATE.exec(value.trim());
  if (!hit) return null;
  const local = Date.parse(`${hit[1]}T${hit[2] ?? "00:00"}:00Z`);
  if (Number.isNaN(local)) return null;
  // Twice, so a local time beside a clock change settles on the offset it falls in.
  const first = local - zoneOffsetMs(local, timeZone);
  return new Date(local - zoneOffsetMs(first, timeZone)).toISOString();
}

const INTEGER = /^-?\d+$/;

export async function checkMaterialRow(input: RowCheck & { readonly targetCode: string }): Promise<{
  materialMatch?: "Matched" | "Unmatched";
  matchNote: "price_currency_differs" | null;
}> {
  const { orgId, destination, lookups, text, set, columnOf, values, issues } = input;
  let materialMatch: "Matched" | "Unmatched" | undefined;
  let matchNote: "price_currency_differs" | null = null;
  const materialBounded = (field: string) => {
    const v = text(field).trim();
    if (!v) return;
    if (v.length > (MATERIAL_MAX_LENGTH[field] ?? 200))
      issues.push({ columnIndex: columnOf(field), issue: "too_long" });
    else values[field] = v;
  };
  if (input.targetCode === "procurement_needs") {
    const projectId = destination.project?.id ?? null;
    materialBounded("description");
    materialBounded("note");
    await set("quantity", (v) => positiveQuantity(v), "invalid_quantity");
    await set("unit_basis", (v) => lookups.unitExists(v), "unknown_unit");
    await set("asset_class_id", (v) => lookups.assetClassId(orgId, v), "unknown_asset_class");
    const zone = projectId ? await lookups.projectTimeZone(projectId) : "UTC";
    const from = text("needed_from") ? zonedInstant(text("needed_from"), zone) : null;
    const to = text("needed_to") ? zonedInstant(text("needed_to"), zone) : null;
    if (text("needed_from") && from === null)
      issues.push({ columnIndex: columnOf("needed_from"), issue: "invalid_time" });
    if (text("needed_to") && to === null)
      issues.push({ columnIndex: columnOf("needed_to"), issue: "invalid_time" });
    if (from && to && to <= from)
      issues.push({ columnIndex: columnOf("needed_to"), issue: "invalid_time" });
    if ((text("needed_from") !== "") !== (text("needed_to") !== ""))
      issues.push({
        columnIndex: columnOf(text("needed_from") ? "needed_to" : "needed_from"),
        issue: "required",
      });
    if (from && to) values["needed_during"] = `[${from},${to})`;
    if (destination.jobId && issues.length === 0) {
      const explicit = values["asset_class_id"] !== undefined;
      const match = explicit
        ? null
        : await lookups.materialMatch(destination.jobId, null, text("description"));
      if (match?.assetClassId) values["asset_class_id"] = match.assetClassId;
      materialMatch = explicit || match ? "Matched" : "Unmatched";
    }
  }
  if (input.targetCode === "po_lines") {
    materialBounded("description");
    await set("quantity", (v) => positiveQuantity(v), "invalid_quantity");
    await set(
      "line_number",
      (v) => (/^\d{1,6}$/.test(v.trim()) && Number(v) > 0 ? Number(v) : null),
      "invalid_position",
    );
    await set("unit_basis", (v) => lookups.unitExists(v), "unknown_unit");
    await set("element_id", (v) => lookups.elementExists(v), "unknown_element");
    await set(
      "unit_price_minor",
      (v) => (INTEGER.test(v) && Number(v) >= 0 ? Number(v) : null),
      "invalid_amount",
    );
    if (destination.jobId && issues.length === 0) {
      const match = await lookups.materialMatch(
        destination.jobId,
        text("vendor_sku") || null,
        text("description"),
      );
      if (match?.elementId && values["element_id"] === undefined)
        values["element_id"] = match.elementId;
      // A vendor's price fills only a blank one, and only in the order's currency.
      if (match && match.unitPriceMinor !== null && values["unit_price_minor"] === undefined) {
        if (match.currencyCode === match.orderCurrencyCode)
          values["unit_price_minor"] = match.unitPriceMinor;
        else matchNote = "price_currency_differs";
      }
      materialMatch = match || values["element_id"] !== undefined ? "Matched" : "Unmatched";
    }
  }
  return { ...(materialMatch ? { materialMatch } : {}), matchNote };
}
