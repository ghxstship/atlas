/**
 * Activity operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Activity resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen Activity resources follow ADR 0023.
 */
import { defineAdditions } from "../additions.ts";
import { all, editShape, setOrder } from "../correct.ts";

export const additions = defineAdditions("Activity", {
  corrections: [
    {
      id: "activity-feed-newest-first",
      since: "1.0.0-draft.2",
      resources: ["activityEvents"],
      change:
        "`actor_id` becomes nullable, and the default order of `activityEvents.list` is `occurred_at` descending, newest first.",
      reason:
        "app.activity_events (0400) records `actor_person_id` NULL for system and platform events, and the feed (app.activity_feed, 0951) returns newest first with a cursor on the time of the last entry.",
      apply: all(
        editShape({ nullable: ["actor_id"] }),
        setOrder({ by: ["occurred_at"], numeric: false, descending: true }),
      ),
    },
  ],
});
