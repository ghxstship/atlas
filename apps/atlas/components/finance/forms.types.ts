import { type Option } from "./kit.types";

// Expenses -----------------------------------------------------------------------------------------

export interface LineOption extends Option {
  readonly currency: string;
  readonly projectId: string;
}

/** A live engagement an expense can name, on its project (6547). */
export interface ActOption extends Option {
  readonly projectId: string;
}

// Change orders ------------------------------------------------------------------------------------

export interface BudgetOption extends Option {
  readonly projectId: string;
}

export interface DraftLine {
  key: number;
  accountCode: string;
  costCenterId: string;
  urid: string;
  description: string;
  debit: string;
  credit: string;
}
