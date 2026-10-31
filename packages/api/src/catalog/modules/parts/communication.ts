/**
 * Needs review and Mark as communicated in the public API (B6, RRR-230, G-120, ADR 0145; migration 2951). Additive
 * actions on shifts (v1 is frozen, Section 10.1):
 *
 *   * `shifts.communicationStatus` reads, for up to 100 shifts named in `ids`, whether the person on each was told of
 *     its changes: when and how they were last told (a coordinator's mark, their own acceptance, or a notification
 *     that reached them), the communicable fields others changed since, and whether the shift needs review. The ids
 *     travel in the URL, so a GET carries at most 100; Atlas reads 500 at a time through the RPC.
 *   * `shifts.markCommunicated` marks up to 500 shifts as communicated for the person on each now, all or nothing.
 *
 * Both need crew.shift.write on every shift's project. Field names only: neither returns a value from the ledger.
 * Seen marks and the diffs computed from them are first-party UI state and have no v1 operation (ADR 0145).
 */
import { z } from "@hono/zod-openapi";
import { fields } from "@xos/schemas";
import { orNull } from "../../correct.ts";
import { collectionAction, collectionQuery } from "../../define.ts";
import type { ActionSpec } from "../../types.ts";

/** The most shift ids `shifts.communicationStatus` takes in its query. */
export const COMMUNICATION_STATUS_MAX_IDS = 100;

const ShiftCommunicationStatus = z
  .object({
    shift_id: fields.uuid("The shift."),
    person_id: orNull(fields.uuid("Person on the shift now; null for an open shift.")),
    told_at: orNull(fields.instant("When the person was last told; null when never.")),
    told_via: orNull(
      z.enum(["marked", "accepted", "notified"]).meta({
        description:
          "How the person was last told: marked (a coordinator marked it as communicated), accepted (they accepted the shift) or notified (a shift notification reached them).",
        example: "notified",
      }),
    ),
    told_by_name: orNull(
      fields.text(
        "Who told them: the coordinator, or whose change sent the notification.",
        "Carol Nguyen",
      ),
    ),
    changed_at: orNull(fields.instant("When the latest communicable change after that was saved.")),
    changed_fields: z.array(z.string().min(1)).meta({
      description:
        "Fields others changed after the person was told, such as role_code or shift_state (a cancellation or a return to Draft). Names only, never values.",
      example: ["role_code"],
    }),
    needs_review: fields.bool(
      "True when the shift is live, has a person on it and ends after now, and either it is Published or Accepted with a change since they were told or was never told, or it was canceled or returned to Draft after they were told.",
      true,
    ),
  })
  .meta({
    id: "ShiftCommunicationStatus",
    description:
      "Whether the person on a shift was told of its changes (Section 4.2 Needs review).",
  });

const statusQuery = z.object({
  ids: z
    .string()
    .regex(/^[0-9a-fA-F-]{36}(,[0-9a-fA-F-]{36})*$/)
    .meta({
      description: `Shift ids, comma-separated, at most ${COMMUNICATION_STATUS_MAX_IDS}; more are refused as communication_too_many.`,
      example: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    }),
});

const MarkCommunicatedRequest = z
  .object({
    ids: z.array(fields.uuid("A shift.")).min(1).max(500).meta({
      description: "Shifts to mark, at most 500.",
    }),
    note: fields
      .text("How the people were told, such as a phone call.", "Called each crew member.", 300)
      .optional(),
  })
  .meta({
    id: "MarkCommunicatedRequest",
    description: "Shifts whose people were told of their changes.",
  });

const MarkCommunicatedResult = z
  .object({ marked: fields.int("Marks saved: one per shift, for the person on it now.", 2) })
  .meta({ id: "MarkCommunicatedResult", description: "What Mark as communicated saved." });

export const shiftCommunicationActions: ActionSpec[] = [
  collectionQuery("communicationStatus", {
    summary: "Read whether shift workers were told of changes",
    description: `For up to ${COMMUNICATION_STATUS_MAX_IDS} shifts, the person on each, when and how they were last told, the communicable fields others changed since, and whether the shift needs review (app.communication_status). Shifts the caller cannot read, or cannot write (crew.shift.write), are left out. More than ${COMMUNICATION_STATUS_MAX_IDS} ids are refused with 422 communication_too_many.`,
    query: statusQuery,
    paged: true,
    response: ShiftCommunicationStatus,
    rpc: "app.communication_status",
  }),
  collectionAction("markCommunicated", {
    summary: "Mark shifts as communicated",
    description:
      "Saves one communication mark per shift for the person on it now, at the same instant (app.mark_communicated); their changes up to then no longer need review. All or nothing: 404 unless the caller holds crew.shift.write on every shift's project, 422 communication_no_assignee for an open or deleted shift and communication_too_many above 500 ids.",
    body: MarkCommunicatedRequest,
    response: MarkCommunicatedResult,
    rpc: "app.mark_communicated",
  }),
];
