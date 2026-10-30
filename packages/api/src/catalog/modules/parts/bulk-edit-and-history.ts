/**
 * Bulk edit and field history in the public API (A106, RRR-151; A88, ADR 0044; migrations 1451 and 1452). Additive
 * actions (v1 is frozen, Section 10.1): each resource that changes in bulk gets `bulkPreview` and `bulkUpdate` over its
 * transactional RPC, and each resource that keeps a field history gets `fieldHistory` over `app.field_history_events`
 * (2061), which answers one row per event, so `limit` and the API's row cap count the same thing.
 *
 *   * A bulk change is all or nothing. The preview runs the same work, triggers and capability checks included, and
 *     always undoes it, so its counts are what applying would do. A refused row is answered in `refused` with its
 *     rule, and then nothing changes (`committed` is false). `inverse` holds the rows that undo a committed change,
 *     to send back through `bulkUpdate`; their `expect` keeps the undo from overwriting a later change.
 *   * A field history answers only someone who can read the row (its table's own read policies decide), and a
 *     Restricted field arrives masked, with neither value.
 *
 * Co-editing has no write operation here: Yjs updates travel over the private Realtime channel `doc:<doc id>` and
 * only a Yjs client can merge them (ADR 0044). `documents.notes` reads a document's co-edited notes as plain text,
 * the one co-edited field no other v1 operation returns.
 */
import { z } from "@hono/zod-openapi";
import { canonCodes, fields, RecordState } from "@xos/schemas";
import { orNull } from "../../correct.ts";
import { collectionAction, itemQuery } from "../../define.ts";
import type { ActionSpec } from "../../types.ts";

const ROW_ID = "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f";

const BulkEditRefusal = z
  .object({
    id: orNull(fields.uuid("Row the refusal is about; null when the row named no valid id.")),
    rule: z.string().min(1).meta({
      description:
        "Why the row cannot change: the database's refusal rule (for example bulk_stale or transition_not_allowed), not_allowed, invalid, invalid_reference or conflict.",
      example: "bulk_stale",
    }),
    message: z.string().meta({
      description: "The database's sentence for the refusal.",
      example: "Someone changed this row after you loaded it; reload to see the change.",
    }),
  })
  .meta({ id: "BulkEditRefusal", description: "A row of a bulk change that cannot change." });

interface BulkInput {
  /** Component name prefix, for example `Record`. */
  readonly name: string;
  /** Plural label for prose, for example `records`. */
  readonly label: string;
  /** The RPC of migration 1451, for example `app.bulk_update_records`. */
  readonly rpc: string;
  /** The fields a row may set and expect, every one optional. */
  readonly values: Record<string, z.ZodType>;
  /** What the resource's bulk change does, in a sentence. */
  readonly does: string;
  /** One example row: the values to set and the values the caller saw. */
  readonly example: {
    readonly set: Record<string, unknown>;
    readonly expect: Record<string, unknown>;
  };
}

/** `bulkPreview` and `bulkUpdate` for one resource, with its request and result components. */
export function bulkActions(input: BulkInput): ActionSpec[] {
  const Values = z
    .strictObject(
      Object.fromEntries(
        Object.entries(input.values).map(([key, schema]) => [key, schema.optional()]),
      ),
    )
    .meta({
      id: `${input.name}BulkValues`,
      description: `Fields of one of the ${input.label} in a bulk change. Only these fields change in bulk.`,
      example: input.example.set,
    });
  const Row = z
    .object({
      id: fields.uuid("Row to change."),
      set: Values,
      expect: Values.optional(),
    })
    .meta({
      id: `${input.name}BulkRow`,
      description: `One of the ${input.label} in a bulk change: the values to \`set\` and, optionally, the values the caller saw (\`expect\`, compare-and-set). A row whose current value differs from \`expect\` is refused as bulk_stale; an instant matches in any ISO 8601 form with an offset (Z or +00:00).`,
      example: { id: ROW_ID, ...input.example },
    });
  const Request = z
    .object({
      rows: z.array(Row).min(1).max(500).meta({
        description: "The rows to change, each once; at most 500.",
      }),
      reason: fields
        .text(
          "Why: recorded as the reason of every state change and in the audit event, and as the replan reason where a moved date needs one.",
          "Client moved the load-in by a day.",
          500,
        )
        .optional(),
    })
    .meta({ id: `${input.name}BulkEditRequest`, description: `A bulk change of ${input.label}.` });
  const Result = z
    .object({
      preview: fields.bool("True for a preview, which never changes anything.", false),
      committed: fields.bool(
        "True only when every row passed and the change was applied. Any refused row means nothing changed.",
        true,
      ),
      changed: fields.int("Rows the change alters, or would alter in a preview.", 1),
      unchanged: fields.int("Rows that already hold the values.", 0),
      refused: z.array(BulkEditRefusal).meta({
        description: "Rows that cannot change, each with its rule; empty when every row passed.",
      }),
      inverse: z.array(Row).meta({
        description:
          "Rows that undo a committed change: the values before as `set` and the values written as `expect`. Empty for a preview or a refused change.",
      }),
    })
    .meta({
      id: `${input.name}BulkEditResult`,
      description: `What a bulk change of ${input.label} did, or would do in a preview.`,
      example: {
        preview: false,
        committed: true,
        changed: 1,
        unchanged: 0,
        refused: [],
        inverse: [{ id: ROW_ID, set: input.example.expect, expect: input.example.set }],
      },
    });
  const shared = `${input.does} Rows are \`{id, set, expect}\`; every row runs the checks a single change runs (capability, lifecycle rules, separation of duties), each in its own subtransaction.`;
  return [
    collectionAction("bulkPreview", {
      summary: `Preview a bulk change of ${input.label}`,
      description: `${shared} Runs the whole change and always undoes it: the counts and refusals are exactly what \`bulkUpdate\` would answer, and nothing changes.`,
      body: Request,
      response: Result,
      rpc: input.rpc,
    }),
    collectionAction("bulkUpdate", {
      summary: `Change ${input.label} in bulk`,
      description: `${shared} All or nothing, in one transaction: when any row is refused nothing changes, \`committed\` is false and \`refused\` names each row with its rule. A committed change writes one bulk audit event per org and answers the \`inverse\` rows that undo it.`,
      body: Request,
      response: Result,
      rpc: input.rpc,
    }),
  ];
}

const uuidOrNull = (description: string) => orNull(fields.uuid(description));

export const recordBulkActions = bulkActions({
  name: "Record",
  label: "records",
  rpc: "app.bulk_update_records",
  does: "Changes the state, owner, accountable party, due time or phase of records (Section 11.7). A state change goes through the record lifecycle, so Blocked needs `blocker_text` and Deferred `replan_reason`; a due time moved from Scheduled onward is logged as a replan.",
  values: {
    record_state: RecordState,
    owner_party_id: uuidOrNull("Owning person or organization."),
    accountable_party_id: uuidOrNull("Accountable person or organization."),
    due_at: orNull(fields.instant("Due instant.")),
    phase_code: orNull(canonCodes.PhaseCode),
    blocker_text: orNull(
      fields.longText("The named blocker, for a move to Blocked.", "Waiting on the rigging plot."),
    ),
    replan_reason: orNull(
      fields.longText("Replan reason, for a move to Deferred.", "Moved to the second weekend."),
    ),
  },
  example: { set: { record_state: "Scheduled" }, expect: { record_state: "Ready" } },
});

export const shiftBulkActions = bulkActions({
  name: "Shift",
  label: "shifts",
  rpc: "app.bulk_update_shifts",
  does: "Publishes, returns to draft or cancels shifts, or assigns or opens them (Section 11.7). A reassigned accepted shift returns to Published, as a single reassignment does.",
  values: {
    shift_state: z
      .enum(["Draft", "Published", "Accepted", "Canceled"])
      .meta({ description: "Shift state.", example: "Published" }),
    membership_id: uuidOrNull("Member the shift is assigned to; null opens the shift."),
  },
  example: { set: { shift_state: "Published" }, expect: { shift_state: "Draft" } },
});

export const invoiceBulkActions = bulkActions({
  name: "Invoice",
  label: "invoices",
  rpc: "app.bulk_update_invoices",
  does: "Approves, disputes or cancels invoices (Section 11.7). An approval keeps every rule of a single approval (finance.invoice.approve, separation of duties, spend authority); one that needs another approver is refused (bulk_needs_further_approval). Invoices are issued one at a time.",
  values: {
    invoice_state: z
      .enum(["Proposed", "Issued", "Approved", "Disputed", "Canceled"])
      .meta({ description: "Invoice state.", example: "Approved" }),
  },
  example: { set: { invoice_state: "Approved" }, expect: { invoice_state: "Proposed" } },
});

export const assetUnitBulkActions = bulkActions({
  name: "AssetUnit",
  label: "asset units",
  rpc: "app.bulk_update_asset_units",
  does: "Moves asset units along their lifecycle or changes their home venue or condition (Section 11.7). Retiring needs assets.write_off.approve, as a single retirement does.",
  values: {
    asset_state: z
      .enum([
        "Proposed",
        "Received",
        "Available",
        "Reserved",
        "Deployed",
        "In Maintenance",
        "Damaged",
        "Lost",
        "Retired",
      ])
      .meta({ description: "Asset lifecycle state.", example: "In Maintenance" }),
    home_venue_id: uuidOrNull("Venue the unit returns to."),
    condition_enum_id: orNull(
      fields.code("Condition: a row of the canon Asset Condition enumeration.", "ENM-017"),
    ),
  },
  example: { set: { asset_state: "In Maintenance" }, expect: { asset_state: "Available" } },
});

// Field history ------------------------------------------------------------------------------------------------------

const FieldHistoryChange = z
  .object({
    field: z.string().min(1).meta({ description: "Column that changed.", example: "due_at" }),
    old_value: z.unknown().meta({
      description: "Stored value before the change, as JSON; null when masked or empty.",
      example: "2026-10-08T14:30:00+00:00",
    }),
    new_value: z.unknown().meta({
      description: "Stored value after the change, as JSON; null when masked or emptied.",
      example: "2026-10-09T14:30:00+00:00",
    }),
    masked: fields.bool(
      "True for a Restricted field the caller may not read: neither value is returned.",
      false,
    ),
  })
  .meta({ id: "FieldHistoryChange", description: "One field changed by an event." });

const FieldHistoryEvent = z
  .object({
    event_id: fields.uuid("Audit event of the change."),
    changed_at: fields.instant("When the change was made."),
    actor_person_id: uuidOrNull("Person who made the change; null for a system change."),
    actor_name: orNull(fields.text("Name of that person.", "Carol Nguyen")),
    operation: z.enum(["insert", "update", "delete"]).meta({
      description: "Created, changed or deleted the row.",
      example: "update",
    }),
    changes: z.array(FieldHistoryChange).meta({
      description: "The fields an update changed; empty for a creation or deletion.",
    }),
  })
  .meta({
    id: "FieldHistoryEvent",
    description:
      "One change to a row from the audit ledger (Section 4.10): who made it, when, and from what to what. Actor IP addresses and user agents are never returned.",
  });

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional().meta({
    description:
      "At most this many events, newest first, each with all of its changes; 200 when omitted.",
    example: 50,
  }),
});

/** `fieldHistory` on one resource that keeps a field history (private.field_history_subjects). */
export function fieldHistoryAction(label: string): ActionSpec {
  return itemQuery("fieldHistory", {
    segment: "field-history",
    summary: `Field history of a ${label}`,
    description: `Who changed which field of the ${label}, when, and from what to what, newest first, from the audit ledger (app.field_history_events). Answers only someone who can read the ${label}: its own read policies decide, and 404 otherwise. A Restricted field is masked without its read capability. \`limit\` counts events, and every event arrives with all of its changes. \`next_cursor\` is always null: the page holds the newest \`limit\` events, and older ones are not returned.`,
    rpc: "app.field_history_events",
    paged: true,
    response: FieldHistoryEvent,
    query: historyQuery,
  });
}

// Co-edited document notes -------------------------------------------------------------------------------------------

const DocumentNotes = z
  .object({
    document_id: fields.ref("document"),
    text: orNull(
      z.string().max(200000).meta({
        description:
          "Plain text of the notes as last saved, at most 200,000 characters; null before anyone wrote any.",
        example: "Bring two copies of the site plan.",
      }),
    ),
    generation: fields.int(
      "Raised when the notes are reloaded from scratch; 0 before anyone opened them.",
      1,
    ),
    saved_through: fields.int("Last edit folded into `text`.", 12),
    latest_edit: fields.int(
      "Last edit made. Greater than `saved_through` while an editor's latest changes are not yet saved into `text`, a few seconds after they type.",
      12,
    ),
  })
  .meta({
    id: "DocumentNotes",
    description:
      "A document's notes, edited together live in Atlas (Section 5), as plain text. Edits arrive over Realtime and are saved into the text when the editor pauses.",
  });

export const documentNotesAction = itemQuery("notes", {
  summary: "Read a document's notes",
  description:
    "The document's co-edited notes as plain text, as last saved (app.doc_snapshots). Answers whoever can read the document, and 404 otherwise. Writing goes through the live editor: notes are a Yjs document whose edits travel over Realtime (ADR 0044).",
  response: DocumentNotes,
});
