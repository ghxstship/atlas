import { type RecordState } from "@xos/ui";

/**
 * Client building blocks the Finance and Reports pages share (A15): the view switcher and filter bar
 * that keep view state in the query string (Section 4.5.3), the table, list and board views, the
 * record peek (Section 11.2 rule 4), the create and edit sheet, lifecycle transition buttons, and
 * the feedback that turns database refusals into catalog copy naming their rule (Sections 8.1, 8.2).
 */

export type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

export interface Option {
  readonly value: string;
  readonly label: string;
}

// Views ----------------------------------------------------------------------------------------------

export type Row = Record<string, unknown> & { readonly id: string };

export interface ListItem {
  readonly id: string;
  readonly recordKey: string;
  readonly title: string;
  readonly state: RecordState;
  readonly stateLabel: string;
  readonly next?: string;
  readonly owner?: string;
}

export interface BoardColumn {
  readonly state: RecordState;
  readonly label: string;
  readonly cards: readonly { key: string; title: string; meta?: string }[];
}

// Lifecycle transitions ---------------------------------------------------------------------------------

export type Lifecycle =
  | "expense"
  | "change_order"
  | "invoice"
  | "payment"
  | "journal"
  | "accounting_period"
  | "settlement";
