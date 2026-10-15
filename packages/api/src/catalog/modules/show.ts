/**
 * Show operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Show resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen Show resources follow ADR 0023.
 */
import { z } from "@hono/zod-openapi";
import { fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { editShape, orNull } from "../correct.ts";

const projectId = (what: string) => ({
  schema: fields.ref(`project of the ${what}`),
  create: "required" as const,
  update: false,
});

const day = (description: string) => ({
  schema: fields.date(description),
  create: "required" as const,
});

const publishedAt = (what: string) => ({
  schema: orNull(
    fields.instant(
      `When the ${what} was published, stamped by the database; set once by the publish action.`,
    ),
  ),
});

export const additions = defineAdditions("Show", {
  corrections: [
    {
      id: "run-of-show-columns",
      since: "1.0.0-draft.2",
      resources: ["runsOfShow"],
      change:
        "Adds `project_id` (required on create); `title` becomes `name`; removes `time_zone` and `published`; `scope_node_id` becomes nullable.",
      reason:
        "app.run_of_show (0350) belongs to a project (NOT NULL `project_id`), names the running order `name`, takes its time zone from the project and has no published flag; its show node is optional.",
      apply: editShape({
        nullable: ["scope_node_id"],
        rename: { title: "name" },
        remove: ["time_zone", "published"],
        add: { project_id: projectId("running order") },
      }),
    },
    {
      id: "cue-columns",
      since: "1.0.0-draft.2",
      resources: ["cues"],
      // The frozen document generated the shared DeptCode component from this nullable field, the
      // first that referenced it, so DeptCode itself read as nullable. Without the field DeptCode is
      // a plain code again; nullable references to it stay nullable.
      components: ["schemas/DeptCode"],
      change:
        "`title` becomes `label`, `fired_at` becomes `called_at` and `duration_seconds` becomes the interval `duration`; adds the server-set `called_by` and `project_id`; removes `cue_code` and `department_dept_code`; `planned_at` becomes nullable.",
      reason:
        "app.cues (0350, 0412) stores the cue's `label`, an optional `planned_at`, a `duration` interval and the call as `called_at` with `called_by` (app.call_cue stamps both); the database stamps `project_id` from the running order; there is no cue code or department column. Removing the department field leaves the shared DeptCode component non-nullable, as every other reference expects.",
      apply: editShape({
        nullable: ["planned_at"],
        rename: { title: "label", fired_at: "called_at" },
        remove: ["cue_code", "duration_seconds", "department_dept_code"],
        add: {
          duration: {
            schema: orNull(
              z
                .string()
                .regex(/^\d{2,}:\d{2}:\d{2}(\.\d+)?$/)
                .meta({
                  description: "Planned length as hours:minutes:seconds.",
                  example: "00:05:00",
                }),
            ),
            create: "optional",
          },
          called_by: {
            schema: orNull(fields.ref("person who called the cue, set by app.call_cue")),
          },
          project_id: {
            schema: fields.ref("project of the running order, stamped by the database"),
          },
        },
      }),
    },
    {
      id: "day-sheet-columns",
      since: "1.0.0-draft.2",
      resources: ["daySheets"],
      change:
        "Adds `project_id` (required on create); `sheet_date` becomes `day`; `body` is rich text as a string; `published` becomes the server-set `published_at`; removes `scope_node_id`.",
      reason:
        "app.day_sheets (0350, 0412) is one sheet per project and day (NOT NULL `project_id` and `day`), stores its body as text, records publication as `published_at` stamped by the database, and has no scope node.",
      apply: editShape({
        rename: { sheet_date: "day" },
        remove: ["scope_node_id", "published"],
        add: {
          project_id: projectId("day sheet"),
          day: day("Day the sheet covers; one sheet per project and day."),
          body: {
            schema: fields.longText(
              "Day sheet content as rich text.",
              "Doors at 18:00. Load-out after the encore.",
            ),
            create: "required",
          },
          published_at: publishedAt("day sheet"),
        },
      }),
    },
    {
      id: "call-sheet-columns",
      since: "1.0.0-draft.2",
      resources: ["callSheets"],
      change:
        "Adds `project_id` (required on create); `sheet_date` becomes `day`; `published` becomes the server-set `published_at`; removes `scope_node_id`, `general_call_at` and `body`.",
      reason:
        "app.call_sheets (0350) is one sheet per project and day (NOT NULL `project_id` and `day`) with a publication time, and has no general call, body or scope node column.",
      apply: editShape({
        rename: { sheet_date: "day" },
        remove: ["scope_node_id", "general_call_at", "body", "published"],
        add: {
          project_id: projectId("call sheet"),
          day: day("Day the sheet covers; one sheet per project and day."),
          published_at: publishedAt("call sheet"),
        },
      }),
    },
  ],
});
