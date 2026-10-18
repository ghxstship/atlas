import { type Option } from "./kit.types";

// Expenses -----------------------------------------------------------------------------------------

export interface LineOption extends Option {
  readonly currency: string;
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
