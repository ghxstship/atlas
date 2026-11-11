import type { BudgetLine, Grade, UridOption } from "@xos/data/finance";
import type { ActionState } from "@/app/[org]/finance/actions";
import type { PresenceMe } from "@/components/presence/presence";

/** What the budget grid and its dialogs share (budget-editor.tsx, budget-editor-dialogs.tsx). */

export interface CostCenterOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export type BudgetColumnSet = "cost" | "client" | "forecast";

export type Cell = string | number | null;
export type GridRow = Record<string, Cell>;

export interface BudgetEditorProps {
  readonly org: string;
  readonly budgetId: string;
  /** The budget's project, whose purchase orders fill Committed. */
  readonly projectId: string;
  /** The viewer, for presence on the budget; null in the moment before their person exists. */
  readonly me: PresenceMe | null;
  readonly currency: string;
  readonly exponent: number;
  /** The lines shown: the whole budget, or those the grid's custom field conditions keep. */
  readonly lines: readonly BudgetLine[];
  /** Every line of the budget, so filtering never hides a contingency source or target; defaults to `lines`. */
  readonly allLines?: readonly BudgetLine[];
  /** The org has custom fields on budget lines, so Line fields is offered (with finance.budget.write). */
  readonly lineFields?: boolean;
  readonly urids: readonly UridOption[];
  readonly costCenters: readonly CostCenterOption[];
  readonly grades: readonly Grade[];
  readonly canWrite: boolean;
  /** Which columns the grid shows (?columns=), server-rendered links beside the toolbar. */
  readonly columnSet?: BudgetColumnSet;
  /** The budget's default markup in basis points, shown in a line's blank Markup cell. */
  readonly defaultMarkupBp?: number | null;
  /** The import wizard for this budget (Import lines), or null when hidden. */
  readonly importHref?: string | null;
}

export const toMajor = (minor: number | null, exponent: number) =>
  minor === null ? null : minor / 10 ** exponent;
export const toMinor = (major: Cell, exponent: number): number | null =>
  major === null || major === "" ? null : Math.round(Number(major) * 10 ** exponent);

export async function submit<T extends Record<string, string>>(
  action: (s: ActionState, f: FormData) => Promise<ActionState>,
  values: T,
): Promise<ActionState> {
  const form = new FormData();
  for (const [k, v] of Object.entries(values)) form.set(k, v);
  return action({}, form);
}
