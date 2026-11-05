import type { BulkResource, BulkValue } from "@xos/data/bulk";

/**
 * What a page hands the bulk edit kit (Section 11.7): the resource, and the properties a person may
 * change across a selection with their choices, every label already translated on the server.
 */

export interface BulkChoice {
  readonly value: BulkValue;
  readonly label: string;
}

export interface BulkField {
  /** The column the RPC sets, for example record_state or owner_party_id. */
  readonly key: string;
  /** The property's name, for "Change {field}". */
  readonly label: string;
  readonly options: readonly BulkChoice[];
  /** Asks for a reason, saved with each change (state changes). */
  readonly reason?: boolean;
  /**
   * The rows this change applies to, when not every row allows it (a work order in a final state
   * has no state to move to). The bar offers the change only when every selected row is listed,
   * and a row's menu only on a listed row. Every row when absent.
   */
  readonly rows?: readonly string[];
}

export interface BulkConfig {
  readonly org: string;
  readonly resource: BulkResource;
  /** At most four properties show as actions; the bar holds five buttons. */
  readonly fields: readonly BulkField[];
}

/** A selectable row: its id and the name refusals and checkboxes use, such as its key. */
export interface BulkRowRef {
  readonly id: string;
  readonly label: string;
}
