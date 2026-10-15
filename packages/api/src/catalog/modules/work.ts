/**
 * Work operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Work resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen Work resources follow ADR 0023.
 */
import { fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { editShape, orNull, removeActions } from "../correct.ts";

const when = (description: string) => ({ schema: orNull(fields.instant(description)) });

export const additions = defineAdditions("Work", {
  corrections: [
    {
      id: "record-archive-removed",
      since: "1.0.0-draft.2",
      resources: ["records"],
      change: "Removes `records.archive`.",
      reason:
        "app.records (0310) has no archived state or column: Trash (the soft delete) hides a record and Canceled is the retained end state of the record lifecycle.",
      apply: removeActions("archive"),
    },
    {
      id: "record-replan-row-per-change",
      since: "1.0.0-draft.2",
      resources: ["recordReplans"],
      change:
        "A replan entry is one change with the state and every date before and after: adds `from_state`, `to_state`, `old_starts_at`, `new_starts_at`, `old_ends_at`, `new_ends_at`, `old_due_at` and `new_due_at`; removes `field`, `from_value` and `to_value`.",
      reason:
        "app.record_replans (0310) writes one row per replanned change with the record state and the start, end and due times before and after; it has no per-field rows.",
      apply: editShape({
        remove: ["field", "from_value", "to_value"],
        add: {
          from_state: {
            schema: fields.stateLabel("Record state before the change.", "Scheduled"),
          },
          to_state: { schema: fields.stateLabel("Record state after the change.", "Deferred") },
          old_starts_at: when("Start before the change."),
          new_starts_at: when("Start after the change."),
          old_ends_at: when("End before the change."),
          new_ends_at: when("End after the change."),
          old_due_at: when("Due time before the change."),
          new_due_at: when("Due time after the change."),
        },
      }),
    },
  ],
});
