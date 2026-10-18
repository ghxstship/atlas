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
};

export type BudgetGridProps = ReferenceBudgetGridProps & {
  onGradeChange?: (grade: string) => void;
};

export type BidSheetProps = ReferenceBidSheetProps & {
  onChange?: (lines: ReferenceBidSheetProps["lines"]) => void;
};

export type Grade = "base" | "elevated" | "premium";
