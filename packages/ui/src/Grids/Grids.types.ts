import type {
  BidSheetProps as ReferenceBidSheetProps,
  BudgetGridProps as ReferenceBudgetGridProps,
  SpreadsheetGridProps as ReferenceSpreadsheetGridProps,
} from "../types/reference";

export type Cell = string | number | null;

export type Row = Record<string, Cell>;

export type SpreadsheetGridProps = ReferenceSpreadsheetGridProps & {
  /** Called with every row after an edit, clear or paste. */
  onChange?: (rows: Row[]) => void;
  /**
   * The column that identifies a row. When set, new `rows` are merged into the grid by this key
   * instead of being ignored: rows added or removed elsewhere appear or go, and a row whose incoming
   * values differ from the last ones received for it takes them, except the row with an open cell,
   * which keeps its draft. The selection and the open cell follow their row.
   */
  rowKey?: string;
  /** Called with the key of the row whose cell opens for editing, and null when it closes. */
  onEditingChange?: (rowKey: string | null) => void;
};

export type BudgetGridProps = ReferenceBudgetGridProps & {
  onGradeChange?: (grade: string) => void;
};

export type BidSheetProps = ReferenceBidSheetProps & {
  onChange?: (lines: ReferenceBidSheetProps["lines"]) => void;
};

export type Grade = "base" | "elevated" | "premium";
