/**
 * Record spine, Schedule, Work and Show (Sections 3.10, 4.2 and 7.4).
 */
import { z } from "zod";
import * as c from "../common/canon-codes.ts";
import * as f from "../common/fields.ts";
import { ExternalRoleType, RecordState } from "../common/enums.ts";
import { defineResource } from "../common/resource.ts";

export const RecordResource = defineResource({
  name: "Record",
  table: "app.records",
  description:
    "A record of any of the 26 kinds. Kind-specific attributes live in 1:1 extension tables keyed by `record_id`.",
  serverSet: ["record_class", "record_state", "record_key"],
  immutable: ["record_kind"],
  fields: {
    record_key: f.code("Display key issued by `next_sequence`.", "NWL-24-118"),
    record_kind: c.RecordKind,
    record_subtype: c.RecordSubtype.nullable(),
    record_class: c.RecordClass,
    record_state: RecordState,
    title: f.text(
      "Title, validated against the kind's title grammar on write.",
      "Install Main Stage Truss",
    ),
    scope_node_id: f.ref("scope node"),
    phase_code: c.PhaseCode,
    urid: c.UridAtAnyGrain.nullable(),
    xyz: c.Xyz,
    owner_party_id: f.ref("owning person or organization").nullable(),
    accountable_party_id: f.ref("accountable person or organization").nullable(),
    starts_at: f.instant("Start of the record window.").nullable(),
    ends_at: f.instant("End of the record window.").nullable(),
    due_at: f.instant("Due instant.").nullable(),
    blocker_text: f
      .longText("The named blocker; required when Blocked.", "Waiting on the rigging plot.")
      .nullable(),
    replan_reason: f
      .longText("Replan reason; required when Deferred.", "Moved to the second weekend.")
      .nullable(),
    external_visibility: z.array(ExternalRoleType).meta({
      description:
        "External role types that may see the record; empty means internal only. Stored as junction rows, presented as a set.",
      example: ["Vendor"],
    }),
  },
});

export const RecordTransitionRequest = z
  .object({
    expected_state: RecordState.meta({
      description: "The state the caller believes the record is in (compare-and-set).",
    }),
    to_state: RecordState,
    blocker_text: z.string().min(1).optional().meta({
      description: "Required when moving to Blocked.",
      example: "Waiting on the rigging plot.",
    }),
    replan_reason: z.string().min(1).optional().meta({
      description: "Required when moving to Deferred.",
      example: "Moved to the second weekend.",
    }),
  })
  .meta({
    id: "RecordTransitionRequest",
    description: "Request to move a record to another state.",
  });

export const RecordStateTransition = defineResource({
  name: "RecordStateTransition",
  table: "app.record_state_transitions",
  description: "An append-only record state transition.",
  serverSet: ["record_id", "from_state", "to_state", "transitioned_at", "transitioned_by"],
  fields: {
    record_id: f.ref("record"),
    from_state: RecordState,
    to_state: RecordState,
    transitioned_at: f.instant("When the state changed."),
    transitioned_by: f.ref("person who changed the state"),
  },
});

export const RecordReplan = defineResource({
  name: "RecordReplan",
  table: "app.record_replans",
  description:
    "An append-only replan entry, logged from Scheduled onward for every date or state change.",
  serverSet: ["record_id", "field", "from_value", "to_value", "reason", "replanned_at"],
  fields: {
    record_id: f.ref("record"),
    field: f.code("Changed field.", "starts_at"),
    from_value: f.text("Previous value.", "2026-10-08T14:30:00Z").nullable(),
    to_value: f.text("New value.", "2026-10-15T14:30:00Z").nullable(),
    reason: f.longText("Replan reason.", "Moved to the second weekend.").nullable(),
    replanned_at: f.instant("When the replan was logged."),
  },
});

export const RecordChecklistItem = defineResource({
  name: "RecordChecklistItem",
  table: "app.record_checklist_items",
  description: "One checklist item of a record. Items are rows, never array positions.",
  immutable: ["record_id"],
  fields: {
    record_id: f.ref("record"),
    position: f.int("Display position.", 1, 1),
    label: f.text("Item label.", "Check the safety cables"),
    done: f.bool("Whether the item is done.", false),
    done_by: f.ref("person who ticked the item").nullable(),
    done_at: f.instant("When the item was ticked.").nullable(),
    evidence_document_id: f.ref("photo or document evidence").nullable(),
  },
  serverSet: ["done_by", "done_at"],
});

export const RecordWatcher = defineResource({
  name: "RecordWatcher",
  table: "app.record_watchers",
  description: "A person watching a record for notifications.",
  immutable: ["record_id", "person_id"],
  fields: { record_id: f.ref("record"), person_id: f.ref("watching person") },
});

export const RecordDependency = defineResource({
  name: "RecordDependency",
  table: "app.record_dependencies",
  description: "A dependency between two records.",
  immutable: ["predecessor_id", "successor_id"],
  fields: {
    predecessor_id: f.ref("predecessor record"),
    successor_id: f.ref("successor record"),
    dependency_type: f.code("Dependency type.", "finish_to_start"),
    lag_minutes: f.int("Lag in minutes; negative for lead.", 0, -100000),
  },
});

export const RecordRecurrence = defineResource({
  name: "RecordRecurrence",
  table: "app.record_recurrences",
  description: "A recurrence rule that generates records.",
  immutable: ["record_id"],
  fields: {
    record_id: f.ref("template record"),
    rrule: f.text("RFC 5545 recurrence rule.", "FREQ=WEEKLY;BYDAY=SA"),
    time_zone: f.timeZone(),
    until: f.date("Last date of the series.").nullable(),
  },
});

export const ScheduleBaseline = defineResource({
  name: "ScheduleBaseline",
  table: "app.schedule_baselines",
  description: "A frozen schedule baseline for variance tracking.",
  immutable: ["project_id"],
  fields: {
    project_id: f.ref("project"),
    name: f.text("Baseline name.", "Gate 3 Baseline"),
    captured_at: f.instant("When the baseline was captured."),
  },
  serverSet: ["captured_at"],
});

export const ScheduleActual = defineResource({
  name: "ScheduleActual",
  table: "app.schedule_actuals",
  description: "Actual start and finish of a record.",
  immutable: ["record_id"],
  fields: {
    record_id: f.ref("record"),
    actual_start_at: f.instant("Actual start.").nullable(),
    actual_end_at: f.instant("Actual finish.").nullable(),
  },
});

export const Calendar = defineResource({
  name: "Calendar",
  table: "app.calendars",
  description: "A working calendar with its time zone.",
  fields: {
    name: f.text("Calendar name.", "Venue Working Days"),
    time_zone: f.timeZone(),
    project_id: f.ref("project").nullable(),
  },
});

export const WorkOrder = defineResource({
  name: "WorkOrder",
  table: "app.work_orders",
  description: "A work order issued against a record, open to bids.",
  serverSet: ["work_order_state"],
  immutable: ["project_id"],
  fields: {
    project_id: f.ref("project"),
    record_id: f.ref("record the work order fulfills").nullable(),
    title: f.text("Work order title.", "Fabricate Bar Fascia"),
    urid: c.UridAtAnyGrain.nullable(),
    work_order_state: f.stateLabel("Work order state.", "Proposed"),
    due_at: f.instant("When the work is due.").nullable(),
    budget_minor: f.money("Budget for the work.", 850000),
    currency: f.currency(),
  },
});

export const WorkOrderBid = defineResource({
  name: "WorkOrderBid",
  table: "app.work_order_bids",
  description: "A bid on a work order.",
  immutable: ["work_order_id", "bidder_organization_id"],
  serverSet: ["bid_state"],
  fields: {
    work_order_id: f.ref("work order"),
    bidder_organization_id: f.ref("bidding organization"),
    amount_minor: f.money("Bid amount.", 790000),
    currency: f.currency(),
    bid_state: f.stateLabel("Bid state.", "Quoted"),
    notes: f.longText("Bid notes.", "Includes delivery and install.").nullable(),
  },
});

export const RunOfShow = defineResource({
  name: "RunOfShow",
  table: "app.run_of_show",
  description: "A run of show for one show scope node.",
  immutable: ["scope_node_id"],
  fields: {
    scope_node_id: f.ref("show scope node"),
    title: f.text("Run of show title.", "Saturday Main Stage"),
    show_date: f.date("Show date."),
    time_zone: f.timeZone(),
    published: f.bool("Whether the run of show is published to crew and clients.", false),
  },
});

export const Cue = defineResource({
  name: "Cue",
  table: "app.cues",
  description: "A cue in a run of show.",
  immutable: ["run_of_show_id"],
  serverSet: ["fired_at"],
  fields: {
    run_of_show_id: f.ref("run of show"),
    position: f.int("Cue order.", 10, 1),
    cue_code: f.code("Cue number.", "LX-12"),
    title: f.text("Cue title.", "Headliner Walk-On"),
    planned_at: f.instant("Planned cue time."),
    duration_seconds: f.int("Planned duration in seconds.", 90),
    department_dept_code: c.DeptCode.nullable(),
    fired_at: f.instant("When the cue was called.").nullable(),
  },
});

export const DaySheet = defineResource({
  name: "DaySheet",
  table: "app.day_sheets",
  description: "A day sheet for one scope node and date.",
  immutable: ["scope_node_id"],
  fields: {
    scope_node_id: f.ref("scope node"),
    sheet_date: f.date("Day the sheet covers."),
    body: f.document("Day sheet body as a rich text document."),
    published: f.bool("Whether the sheet is published.", false),
  },
});

export const CallSheet = defineResource({
  name: "CallSheet",
  table: "app.call_sheets",
  description: "A call sheet listing call times for one scope node and date.",
  immutable: ["scope_node_id"],
  fields: {
    scope_node_id: f.ref("scope node"),
    sheet_date: f.date("Day the sheet covers."),
    general_call_at: f.instant("General crew call."),
    body: f.document("Call sheet body as a rich text document."),
    published: f.bool("Whether the sheet is published.", false),
  },
});
