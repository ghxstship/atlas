import { nullAwareSum } from "@xos/data/finance";
import { isConditionParam } from "@/lib/views/query";

/**
 * A budget's lines under the grid's custom field conditions (P10, gap G-217): the lines the Add filter control
 * keeps and their NULL-aware subtotal, beside the whole budget's line count. The budget figures
 * (app.budget_totals) always cover every line; only the grid, the matrix and their totals follow the filter.
 */

export interface FilteredLines<L> {
  /** The lines the conditions keep, in budget order. */
  readonly shown: readonly L[];
  /** Every line of the budget. */
  readonly total: number;
  /** True while conditions apply, so the page says how many lines it shows. */
  readonly filtered: boolean;
  /** The shown lines' NULL-aware total (Section 3.7): blank when any shown line is unpriced. */
  readonly subtotal: ReturnType<typeof nullAwareSum>;
}

/** True when the query holds an Add filter condition (`f.*` or `cf.*`). */
export function hasConditions(search: Readonly<Record<string, string>>): boolean {
  return Object.keys(search).some(isConditionParam);
}

/** The query changes that clear every condition and keep the rest (the budget, the view, the currency). */
export function clearConditions(
  search: Readonly<Record<string, string>>,
): Readonly<Record<string, null>> {
  return Object.fromEntries(
    Object.keys(search)
      .filter(isConditionParam)
      .map((k) => [k, null]),
  );
}

export function filterBudgetLines<
  L extends { readonly id: string; readonly extendedMinor: number | null },
>(lines: readonly L[], keep: (id: string) => boolean, filtered: boolean): FilteredLines<L> {
  const shown = filtered ? lines.filter((l) => keep(l.id)) : lines;
  return {
    shown,
    total: lines.length,
    filtered,
    subtotal: nullAwareSum(shown.map((l) => l.extendedMinor)),
  };
}
