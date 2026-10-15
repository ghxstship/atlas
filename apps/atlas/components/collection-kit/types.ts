import type { RecordState } from "@xos/ui";

/**
 * Serializable shapes a server page hands the collection kit (A16). Pages build rows from
 * repository results with every label already translated, so the client components only render.
 */

export type ViewKind = "table" | "list" | "board" | "gallery" | "calendar" | "chart";

export interface KitState {
  readonly state: RecordState;
  readonly label: string;
}

export type KitCell = string | number | null | KitState;

export interface KitColumn {
  readonly key: string;
  readonly label: string;
  readonly type?: "text" | "code" | "number" | "money" | "state";
  readonly currency?: string;
  readonly wrap?: boolean;
}

export interface KitRow {
  readonly id: string;
  /** Display key, for example NWL-PO7 or an item ID. */
  readonly key: string;
  readonly title: string;
  readonly state?: KitState;
  /** Board column the row sits in (a state value). */
  readonly boardValue?: string;
  /** Calendar date as YYYY-MM-DD. */
  readonly date?: string;
  /** One secondary line for list, board and gallery views. */
  readonly meta?: string;
  readonly cells: Readonly<Record<string, KitCell>>;
}

export interface KitBoardColumn {
  readonly value: string;
  readonly state: RecordState;
  readonly label: string;
}

export interface KitChart {
  readonly title: string;
  readonly categoryLabel: string;
  readonly categories: readonly string[];
  readonly series: readonly { readonly name: string; readonly values: readonly (number | null)[] }[];
  readonly format?: "number" | "money";
  readonly currency?: string;
}

/** Maps a stored lifecycle state onto the design system's nine record states. */
export const LIFECYCLE_TO_RECORD_STATE: Readonly<Record<string, RecordState>> = {
  Proposed: "proposed",
  Prospect: "proposed",
  Onboarded: "ready",
  Issued: "active",
  Active: "active",
  Approved: "ready",
  Sent: "active",
  Closed: "complete",
  Awarded: "complete",
  Blocked: "blocked",
  Rejected: "canceled",
  Withdrawn: "canceled",
  Canceled: "canceled",
};

export function recordStateOf(lifecycle: string): RecordState {
  return LIFECYCLE_TO_RECORD_STATE[lifecycle] ?? "proposed";
}
