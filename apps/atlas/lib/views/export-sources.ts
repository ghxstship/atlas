import type { Database } from "@xos/data/database.types";
import { queryToView } from "./query";

/**
 * What each Atlas collection exports (A102, Section 4.6.4): the collection key of the page
 * (lib/views/query.ts collectionKeyFor) to the one table or view its rows come from, the columns of
 * its table view, and how the page's URL narrows it. app.request_export classifies those columns
 * (Section 8.6) and the export.render worker reads them as the viewer, so an export never shows more
 * than the page could.
 *
 * - `filters` maps a URL filter (Section 11.15: every query key that is not view, q, group, sort or
 *   navigation) to the column it compares. A list such as `state=Open,Done` matches any value; a
 *   project key resolves to the project's id, and a source with a project column honors `project`
 *   without saying so. Query keys a source does not name are left out.
 * - `project` scopes a project tab to the project in its path; `objectType` scopes a custom object page
 *   to the object type in its path.
 * - `fixed` holds the filters the page itself applies, such as Milestones showing Milestone records.
 * - `presence` holds the filters on whether a column is set that the page applies by default and a
 *   query key changes, such as Projects hiding archived projects unless `?archived=1`.
 * - `sections` picks the source by a query key when a page switches between collections in place,
 *   such as a project's Procurement tab (`?section=rfqs`).
 *
 * Every column's header comes from `views.export.columns.<column>` in the viewer's language; the
 * catalog tests hold each one present in en-US and es-US.
 */

type AppTables = Database["app"]["Tables"];
type AppViews = Database["app"]["Views"];
type CanonTables = Database["xpms"]["Tables"];
type CanonViews = Database["xpms"]["Views"];

export type ExportRelation =
  | `app.${Extract<keyof AppTables, string>}`
  | `app.${Extract<keyof AppViews, string>}`
  | `xpms.${Extract<keyof CanonTables, string>}`
  | `xpms.${Extract<keyof CanonViews, string>}`;

type RowOf<R extends ExportRelation> = R extends `app.${infer N}`
  ? N extends keyof AppTables
    ? AppTables[N]["Row"]
    : N extends keyof AppViews
      ? AppViews[N]["Row"]
      : never
  : R extends `xpms.${infer N}`
    ? N extends keyof CanonTables
      ? CanonTables[N]["Row"]
      : N extends keyof CanonViews
        ? CanonViews[N]["Row"]
        : never
    : never;

/** A column of a relation, checked against the generated database types. */
export type ColumnOf<R extends ExportRelation> = Extract<keyof RowOf<R>, string>;

/** How a URL filter narrows an export: the column it compares, and whether its value is a project key. */
export interface ExportFilterSpec {
  readonly column: string;
  readonly resolve?: "project";
}

/** Which rows a page shows by whether a column is set: those where it is unset, set, or either. */
export type ExportPresence = "unset" | "set" | "any";

/**
 * A filter on whether a column is set that a page applies by default and a query key changes: the
 * rows each value of the key shows, and those the page shows without it (or with a value it does not know).
 */
export interface ExportPresenceSpec {
  readonly column: string;
  readonly param: string;
  readonly options: Readonly<Record<string, ExportPresence>>;
  readonly fallback: ExportPresence;
}

export interface ExportSource {
  readonly relation: ExportRelation;
  readonly columns: readonly string[];
  readonly filters: Readonly<Record<string, ExportFilterSpec>>;
  readonly fixed: Readonly<Record<string, string>>;
  readonly presence: readonly ExportPresenceSpec[];
  readonly project: boolean;
  readonly objectType: boolean;
}

export interface ExportSections {
  /** The query key that names the section, such as `section`. */
  readonly param: string;
  /** The section a page shows without the key. */
  readonly fallback: string;
  readonly options: Readonly<Record<string, ExportSource>>;
}

export type ExportEntry = ExportSource | ExportSections;

interface SourceOptions<C extends string> {
  readonly filters?: Readonly<
    Record<string, C | { readonly column: C; readonly resolve: "project" }>
  >;
  readonly fixed?: Readonly<Partial<Record<C, string>>>;
  readonly presence?: readonly (ExportPresenceSpec & { readonly column: C })[];
  readonly project?: boolean;
  readonly objectType?: boolean;
}

function source<R extends ExportRelation>(
  relation: R,
  columns: readonly ColumnOf<R>[],
  options: SourceOptions<ColumnOf<R>> = {},
): ExportSource {
  // A source with the project column narrows to the project its page filters on (`?project=NWL`).
  const filters: Record<string, ExportFilterSpec> = (columns as readonly string[]).includes(
    "project_id",
  )
    ? { project: { column: "project_id", resolve: "project" } }
    : {};
  for (const [key, spec] of Object.entries(options.filters ?? {})) {
    if (spec === undefined) continue;
    filters[key] = typeof spec === "string" ? { column: spec } : spec;
  }
  const fixed: Record<string, string> = {};
  for (const [column, value] of Object.entries(options.fixed ?? {})) {
    if (typeof value === "string") fixed[column] = value;
  }
  return {
    relation,
    columns,
    filters,
    fixed,
    presence: options.presence ?? [],
    project: options.project ?? false,
    objectType: options.objectType ?? false,
  };
}

function sections(
  param: string,
  fallback: string,
  options: Readonly<Record<string, ExportSource>>,
): ExportSections {
  return { param, fallback, options };
}

/** A source on a project tab: the same rows, those of the project in the path. */
function inProject(of: ExportSource): ExportSource {
  return { ...of, project: true };
}

// Shared sources ------------------------------------------------------------------------------------------------------

// The feed with each entry's project (2370): org-wide on the Activity page, the project's on a project tab.
const activity = source("app.activity_export", [
  "created_at",
  "actor_person_id",
  "domain_event_id",
  "project_id",
]);

const records = source(
  "app.records",
  [
    "record_number",
    "title",
    "record_kind",
    "record_subtype",
    "record_state",
    "phase_code",
    "owner_party_id",
    "starts_at",
    "ends_at",
    "due_at",
    "project_id",
  ],
  { filters: { kind: "record_kind", state: "record_state" } },
);

const homeRecords = source("app.records", [
  "record_number",
  "title",
  "record_kind",
  "record_state",
  "due_at",
  "updated_at",
  "project_id",
]);

const gateCriteria = source("app.gate_criteria_status", [
  "project_id",
  "gate",
  "criterion_id",
  "is_blocking",
  "evidence_count",
  "best_assertion_rank",
  "gate_passed",
]);

// The Projects page lists archived projects only with `?archived=1` (components/projects/projects-page.tsx).
const projects = source(
  "app.projects",
  [
    "project_key",
    "name",
    "project_state",
    "production_state",
    "current_phase_code",
    "jurisdiction_id",
    "venue_id",
    "tier_code",
    "starts_on",
    "ends_on",
  ],
  {
    presence: [
      { column: "archived_at", param: "archived", options: { "1": "any" }, fallback: "unset" },
    ],
  },
);

const packets = source(
  "app.advance_packets",
  ["title", "project_id", "due_at", "sent_at", "created_at"],
  {
    filters: { project: { column: "project_id", resolve: "project" } },
  },
);
const riders = source("app.riders", ["title", "project_id", "counterparty_id", "created_at"], {
  filters: { project: { column: "project_id", resolve: "project" } },
});
const reconciliations = source("app.reconciliations", ["reconciled_at", "project_id", "note"], {
  filters: { project: { column: "project_id", resolve: "project" } },
});
const submissions = source("app.advance_recipients", [
  "advance_packet_id",
  "person_id",
  "counterparty_id",
  "created_at",
]);
const guests = source("app.guest_list_entries", [
  "guest_name",
  "plus_ones",
  "scope_node_id",
  "counterparty_id",
  "entry_state",
  "checked_in_at",
  "note",
  "project_id",
]);
// R4: the crew roster, through the producing org's read view (the person resolved, no profile value).
const crewRoster = source("app.roster_entry_people", [
  "full_name",
  "party_name",
  "job_title",
  "arrival_starts_at",
  "arrival_ends_at",
  "arrival_time_zone",
  "entry_state",
  "person_response",
  "project_id",
]);

// R7: what each party and person is given, read from the computed status (no prices).
const allocations = source("app.advance_allocation_status", [
  "item_name",
  "kind",
  "quantity",
  "display_status",
  "allocation_state",
  "origin",
  "needed_time_zone",
  "reserved_quantity",
  "issued_quantity",
  "returned_quantity",
  "decline_reason",
  "project_id",
]);

const custody = source("app.asset_custody", [
  "created_at",
  "asset_unit_id",
  "custodian_membership_id",
  "custodian_engagement_id",
  "project_id",
  "venue_id",
  "note",
]);

const credentialCategories = source("app.credential_categories", ["code", "name", "project_id"]);
const credentials = source("app.credentials", [
  "credential_number",
  "holder_person_id",
  "credential_category_id",
  "project_id",
  "valid_from",
  "valid_to",
  "revoked_at",
]);
const accessGrid = source("app.access_grid", [
  "credential_category_id",
  "zone_id",
  "access_level_enum_id",
  "window_starts_at",
  "window_ends_at",
  "project_id",
]);
const accessScans = source("app.access_scans", [
  "scanned_at",
  "credential_id",
  "zone_id",
  "result",
  "project_id",
]);

const shifts = source(
  "app.shifts",
  [
    "project_id",
    "membership_id",
    "role_code",
    "starts_at",
    "ends_at",
    "scheduled_break_minutes",
    "shift_state",
  ],
  { filters: { state: "shift_state" } },
);

const documents = source("app.documents", ["title", "project_id", "updated_at"]);

const fulfillments = source("app.fulfillments", [
  "fulfillment_number",
  "title",
  "fulfillment_kind",
  "fulfillment_state",
  "counterparty_id",
  "starts_at",
  "ends_at",
  "project_id",
]);
const beos = source("app.beos", [
  "beo_number",
  "fulfillment_id",
  "event_at",
  "guest_count",
  "approved_at",
  "project_id",
]);
const blocks = source("app.accommodation_blocks", [
  "block_number",
  "title",
  "counterparty_id",
  "check_in_on",
  "check_out_on",
  "rooms_held",
  "release_on",
  "nightly_rate_minor",
  "currency_code",
  "project_id",
]);

const shipments = source("app.shipments", [
  "shipment_number",
  "direction",
  "description",
  "freight_type_enum_id",
  "tracking_identifier",
  "ships_at",
  "arrives_at",
  "piece_count",
  "weight_lb",
  "project_id",
]);
const dockSlots = source("app.dock_slots", [
  "starts_at",
  "ends_at",
  "zone_id",
  "shipment_id",
  "checked_in_at",
  "project_id",
]);
const yard = source("app.marshalling_log", [
  "logged_at",
  "project_id",
  "entry",
  "shipment_id",
  "zone_id",
  "created_by",
]);

const purchaseOrders = source("app.purchase_orders", [
  "po_number",
  "vendor_id",
  "project_id",
  "po_state",
  "currency_code",
  "delivery_due_on",
  "payment_terms_days",
  "tax_minor",
  "shipping_minor",
]);
// Goods receipts with their purchase order's project (2370), so a project tab exports its own.
const receipts = source("app.goods_receipt_export", [
  "purchase_order_id",
  "received_at",
  "received_by",
  "note",
  "project_id",
]);
const rfqs = source("app.rfqs", [
  "rfq_number",
  "title",
  "rfq_state",
  "responses_due_at",
  "project_id",
]);
const submittals = source("app.submittals", [
  "submittal_number",
  "title",
  "vendor_id",
  "submittal_kind",
  "due_on",
  "revision",
  "submittal_state",
  "project_id",
]);

const incidents = source("app.incidents", [
  "incident_number",
  "title",
  "severity_enum_id",
  "zone_id",
  "occurred_at",
  "incident_state",
  "project_id",
]);
const permits = source("app.permit_requirements", [
  "permit_rule",
  "project_id",
  "record_id",
  "created_at",
]);

const runsOfShow = source("app.run_of_show", ["name", "show_date", "scope_node_id", "project_id"]);

const reports = source("app.report_definitions", [
  "name",
  "source_code",
  "chart",
  "shared",
  "updated_at",
]);

const budgetLines = source("app.budget_line_facts", [
  "line_number",
  "description",
  "line_type",
  "urid",
  "account_code",
  "cost_center_code",
  "extended_minor",
  "is_unpriced",
  "actual_minor",
  "currency_code",
  "project_id",
]);

const postingLines = source("app.posting_lines", [
  "date",
  "project_id",
  "account_code",
  "cost_center_id",
  "urid",
  "vendor_id",
  "description",
  "quantity",
  "unit_basis",
  "amount_minor",
  "tax_type",
  "currency",
  "external_ref",
  "line_state",
]);

const payments = source("app.payments", [
  "paid_on",
  "counterparty_id",
  "payee_person_id",
  "direction",
  "reference_identifier",
  "amount_minor",
  "currency_code",
  "payment_state",
]);

// The collections --------------------------------------------------------------------------------------------------

export const EXPORT_SOURCES: Readonly<Record<string, ExportEntry>> = {
  "activity/feed": activity,

  "advancing/crew": crewRoster,
  "advancing/allocations": allocations,
  "advancing/packets": packets,
  "advancing/reconciliation": reconciliations,
  "advancing/riders": riders,
  "advancing/submissions": submissions,

  "assets/asset_classes": source("app.asset_classes", ["name", "element_id", "created_at"]),
  "assets/custody_ledger": custody,
  "assets/damage": source("app.asset_damage", [
    "reported_at",
    "asset_unit_id",
    "description",
    "project_id",
    "responsible_counterparty_id",
  ]),
  "assets/lots": source("app.asset_lots", ["asset_class_id", "venue_id", "quantity", "created_at"]),
  "assets/maintenance": source("app.asset_maintenance", [
    "performed_on",
    "asset_unit_id",
    "description",
    "cost_minor",
    "currency_code",
  ]),
  "assets/units": source("app.asset_units", [
    "asset_tag",
    "asset_class_id",
    "asset_state",
    "condition_enum_id",
    "home_venue_id",
  ]),

  "canon/categories": source("xpms.dim_category", [
    "cat_urid",
    "category",
    "disc_code",
    "xyz",
    "is_extension",
  ]),
  "canon/departments": source("xpms.dim_department", ["dept_code", "department", "core_function"]),
  "canon/disciplines": source("xpms.dim_discipline", [
    "disc_code",
    "discipline",
    "dept_code",
    "source",
    "is_extension",
  ]),
  "canon/elements": source("xpms.elements", [
    "element_id",
    "common_name",
    "item",
    "urid",
    "kind",
    "unit_basis",
    "grade",
    "lead_time_hours",
  ]),
  "canon/jurisdictions_and_permit_rules": source("xpms.jurisdiction", [
    "jurisdiction_id",
    "level",
    "country",
    "parent",
    "status",
  ]),
  "canon/metrics": source("xpms.dim_metric", [
    "domain",
    "item",
    "value_numeric",
    "value_text",
    "qualifier",
    "jurisdiction_id",
  ]),
  "canon/org_extensions": source("app.canon_extension_proposals", [
    "proposed_code",
    "label",
    "extension_level",
    "parent_code",
    "proposal_state",
    "created_at",
  ]),
  "canon/phases_and_gates": source("xpms.dim_phase", [
    "gate",
    "phase_code",
    "phase",
    "act_code",
    "gate_exit",
  ]),
  "canon/record_kinds": source("xpms.dim_record_kind", [
    "record_kind",
    "record_class",
    "definition",
  ]),
  "canon/roles": source("xpms.dim_role", [
    "role_code",
    "role",
    "job_title",
    "dept_code",
    "staffing_ratio",
    "ratio_basis",
  ]),

  "credentials/access_grid": accessGrid,
  "credentials/categories": credentialCategories,
  "credentials/issued": credentials,
  "credentials/scan_log": accessScans,

  "crew/pay_periods": source("app.pay_periods", ["starts_on", "ends_on", "pay_period_state"], {
    filters: { state: "pay_period_state" },
  }),
  "crew/payroll_exports": source("app.payroll_exports", [
    "created_at",
    "payroll_run_id",
    "provider",
    "checksum_sha256",
  ]),
  "crew/per_diems": source("app.per_diems", [
    "project_id",
    "membership_id",
    "engagement_id",
    "day",
    "amount_minor",
    "currency_code",
  ]),
  // The rate is Restricted (Section 8.3): the masked view shows it only to holders of the payroll read
  // capability, and exporting it asks for the restricted export capability and step-up.
  "crew/rate_cards": source(
    "app.rate_card_lines_masked",
    [
      "role_code",
      "worker_classification",
      "pay_basis",
      "arrangement",
      "overtime_rule_id",
      "rate_minor",
    ],
    { filters: { card: "rate_card_id" } },
  ),
  "crew/schedule": shifts,
  "crew/shifts": shifts,
  "crew/swaps": source(
    "app.shift_swaps",
    [
      "project_id",
      "shift_id",
      "requested_by_membership_id",
      "proposed_membership_id",
      "swap_state",
    ],
    { filters: { state: "swap_state" } },
  ),
  "crew/time_entries": source("app.time_entries", [
    "membership_id",
    "project_id",
    "clock_in",
    "clock_out",
    "break_minutes",
    "source",
    "needs_review",
  ]),
  "crew/time_off": source(
    "app.time_off_requests",
    ["membership_id", "time_off_policy_id", "starts_on", "ends_on", "hours", "time_off_state"],
    { filters: { state: "time_off_state" } },
  ),
  "crew/timesheets": source(
    "app.timesheets",
    ["membership_id", "project_id", "period_start", "period_end", "timesheet_state"],
    { filters: { state: "timesheet_state" } },
  ),

  "finance/budgets": source("app.budget_revised_totals", [
    "budget_id",
    "project_id",
    "currency_code",
    "line_count",
    "unpriced_count",
    "total_minor",
    "revised_total_minor",
    "actual_minor",
  ]),
  "finance/change_orders": source("app.change_orders", [
    "change_order_number",
    "title",
    "budget_id",
    "order_type_enum_id",
    "schedule_impact_days",
    "change_order_state",
    "project_id",
  ]),
  "finance/chart_of_accounts": source("xpms.dim_gl_account", [
    "account_code",
    "account_name",
    "account_type",
    "class_code",
    "tax_type",
  ]),
  "finance/cost_centers": source("app.cost_centers", ["code", "name", "kind", "scope_node_id"]),
  "finance/expenses": source("app.expenses", [
    "incurred_on",
    "description",
    "budget_line_id",
    "counterparty_id",
    "amount_minor",
    "currency_code",
    "expense_state",
  ]),
  "finance/invoices": source("app.invoices", [
    "invoice_number",
    "direction",
    "counterparty_id",
    "project_id",
    "issued_on",
    "due_on",
    "currency_code",
    "invoice_state",
  ]),
  "finance/journal": source("app.journal_entries", [
    "entry_date",
    "memo",
    "project_id",
    "source_table",
    "journal_state",
  ]),
  "finance/payments": payments,
  "finance/periods": source("app.accounting_periods", ["starts_on", "ends_on", "period_state"]),
  "finance/universal_posting_line_export": postingLines,
  "finance/year_end": payments,

  "home/alerts": homeRecords,
  "home/gate_readiness": gateCriteria,
  "home/recent": homeRecords,
  "home/today": homeRecords,

  "hospitality/accommodation_blocks": blocks,
  "hospitality/beos": beos,
  "hospitality/fulfillments": fulfillments,

  "knowledge/documents": documents,
  "knowledge/feed": source("app.feed_posts", [
    "post_kind",
    "title",
    "audience_kind",
    "author_membership_id",
    "publish_at",
    "requires_acknowledgment",
    "pinned_at",
  ]),
  "knowledge/forms": source("app.form_templates", [
    "name",
    "record_kind",
    "template_state",
    "current_version",
  ]),
  "knowledge/handbook": source("app.handbook_articles", [
    "handbook_section_id",
    "title",
    "article_state",
    "published_version",
    "is_mandatory",
  ]),
  "knowledge/sops": source("app.sops", ["code", "title", "version", "published_at"]),
  "knowledge/training": source("app.training_courses", [
    "title",
    "course_state",
    "role_code",
    "validity_days",
    "estimated_minutes",
  ]),
  "knowledge/verbiage_library": source("app.verbiage_terms", ["term", "casing_rule", "definition"]),

  "logistics/dock_schedule": dockSlots,
  "logistics/marshalling_yard_log": yard,
  "logistics/shipments": shipments,

  // The reader's own open records (2370), as the page lists them; never the org's assignments.
  my_work: source("app.my_work_export", [
    "record_number",
    "title",
    "record_kind",
    "record_state",
    "due_at",
    "starts_at",
    "ends_at",
    "updated_at",
    "project_id",
  ]),

  // Custom objects: every page under /objects/<key> shares this source (exportSourceFor).
  "objects/*": source("app.custom_object_records", ["title", "created_at", "updated_at"], {
    objectType: true,
  }),

  "project/activity": inProject(activity),
  "project/advancing": sections("section", "packets", {
    packets: inProject(packets),
    riders: inProject(riders),
    reconciliation: inProject(reconciliations),
    guests: inProject(guests),
    crew: inProject(crewRoster),
    allocations: inProject(allocations),
    submissions,
  }),
  "project/assets": inProject(custody),
  "project/budget": inProject(budgetLines),
  "project/credentials": sections("section", "issued", {
    issued: inProject(credentials),
    categories: inProject(credentialCategories),
    "access-grid": inProject(accessGrid),
    "scan-log": inProject(accessScans),
  }),
  "project/crew": inProject(shifts),
  "project/documents": inProject(documents),
  "project/gates": inProject(gateCriteria),
  "project/hospitality": sections("section", "fulfillments", {
    fulfillments: inProject(fulfillments),
    beos: inProject(beos),
    blocks: inProject(blocks),
  }),
  "project/logistics": sections("section", "shipments", {
    shipments: inProject(shipments),
    dock: inProject(dockSlots),
    yard: inProject(yard),
  }),
  "project/overview": inProject(activity),
  "project/procurement": sections("section", "purchase-orders", {
    "purchase-orders": inProject(purchaseOrders),
    receipts: inProject(receipts),
    rfqs: inProject(rfqs),
    submittals: inProject(submittals),
  }),
  "project/reports": reports,
  "project/safety": inProject(permits),
  "project/schedule": inProject(records),
  "project/scope": inProject(
    source("app.scope_nodes", ["scope_code", "name", "scope_kind", "parent_id", "venue_id"]),
  ),
  "project/settings": inProject(
    source("app.project_members", ["membership_id", "project_role", "valid_from", "valid_to"]),
  ),
  "project/show": inProject(runsOfShow),
  "project/work": inProject(records),

  "people/agreements": source(
    "app.agreements",
    [
      "title",
      "agreement_kind",
      "person_id",
      "counterparty_id",
      "agreement_state",
      "signed_at",
      "created_at",
    ],
    { filters: { state: "agreement_state" } },
  ),
  "people/certifications": source("app.certification_holders", [
    "person_id",
    "certification_id",
    "issued_on",
    "expires_on",
    "verified_by",
  ]),
  "people/directory": source("app.memberships", ["person_id", "valid_from", "valid_to"]),
  "people/groups": source("app.groups", ["group_kind", "name", "project_id", "archived_at"]),
  "people/help_desk": source("app.support_tickets", [
    "ticket_number",
    "subject",
    "category",
    "severity",
    "ticket_state",
    "help_desk_team_id",
    "assignee_membership_id",
    "help_desk_response_due_at",
  ]),
  "people/offers": source("app.offers", ["application_id", "offer_state", "created_at"], {
    filters: { state: "offer_state" },
  }),
  "people/recognition": source("app.recognitions", [
    "to_membership_id",
    "from_membership_id",
    "message",
    "project_id",
    "created_at",
  ]),
  "people/requisitions": source(
    "app.requisitions",
    [
      "project_id",
      "role_code",
      "headcount",
      "rate_minor",
      "currency_code",
      "starts_on",
      "ends_on",
      "requisition_state",
    ],
    { filters: { state: "requisition_state" } },
  ),
  "people/roles": source("app.role_assignments", [
    "role_code",
    "person_id",
    "project_id",
    "staffing_basis",
    "starts_on",
    "ends_on",
    "assignment_state",
  ]),

  "places/capability_documents": source("app.capability_documents", [
    "title",
    "venue_id",
    "valid_from",
    "valid_to",
    "is_frozen",
  ]),
  "places/site_plans": source("app.site_plans", ["title", "venue_id", "project_id"]),
  "places/spaces_and_zones": source("app.spaces", [
    "name",
    "venue_id",
    "urid",
    "capacity",
    "area_sq_ft",
    "description",
  ]),
  "places/venues": source("app.venues", [
    "name",
    "jurisdiction_id",
    "time_zone",
    "street_address",
    "locality",
    "postal_code",
  ]),

  "procurement/catalog": source("app.catalog_bindings", [
    "item_id",
    "name",
    "element_id",
    "unit_basis",
    "default_unit_price_minor",
    "currency_code",
  ]),
  "procurement/invoice_matching": source("app.invoice_matches", [
    "invoice_id",
    "purchase_order_id",
    "goods_receipt_id",
    "resolved_at",
    "resolution_note",
  ]),
  "procurement/purchase_orders": purchaseOrders,
  "procurement/receipts": receipts,
  "procurement/rfqs": rfqs,

  projects,
  "projects/all": projects,
  "projects/by_phase": projects,
  "projects/portfolio_timeline": projects,

  "reports/budget_versus_actual": budgetLines,
  "reports/coordinate_matrix": source("xpms.v_coordinate_matrix", [
    "dept_code",
    "department",
    "phase_code",
    "gate",
    "phase",
    "coordinate",
    "element_count",
  ]),
  "reports/final_cost_report": postingLines,
  "reports/gate_readiness": gateCriteria,
  "reports/incidents": incidents,
  "reports/labor": source("app.timesheet_hours", [
    "timesheet_id",
    "project_id",
    "membership_id",
    "worked_minutes",
    "has_open_entry",
  ]),
  "reports/measurement": source("app.project_measurement_summary", [
    "project_id",
    "metric_code",
    "family",
    "aggregation",
    "target_value",
    "measured_count",
    "measured_base",
    "last_measured_on",
    "outcome",
  ]),
  "reports/purchase_order_exposure": source("app.purchase_order_totals", [
    "purchase_order_id",
    "project_id",
    "currency_code",
    "unpriced_count",
    "lines_total_minor",
    "approved_changes_minor",
  ]),
  "reports/saved_reports": reports,

  "safety/dispatch_board": incidents,
  "safety/emergency_codes": source("xpms.emergency_code", [
    "code",
    "label",
    "emergency",
    "sort_order",
  ]),
  "safety/incidents": incidents,
  "safety/inspection_templates": source("app.inspection_templates", ["name", "created_at"]),
  "safety/inspections": source("app.inspections", [
    "inspection_template_id",
    "project_id",
    "inspected_at",
    "inspector_person_id",
    "signed_off_at",
  ]),
  "safety/permits": permits,
  "safety/radio_channels": source("app.radio_channels", [
    "channel_number",
    "name",
    "zone_id",
    "project_id",
  ]),

  "schedule/baselines": source("app.schedule_baselines", [
    "name",
    "project_id",
    "locked_at",
    "created_at",
  ]),
  "schedule/calendar": records,
  "schedule/events": source("app.workforce_events", [
    "event_kind",
    "title",
    "starts_at",
    "ends_at",
    "location",
    "canceled_at",
    "project_id",
  ]),
  "schedule/milestones": source(
    "app.records",
    ["record_number", "title", "record_state", "due_at", "project_id"],
    { filters: { state: "record_state" }, fixed: { record_kind: "Milestone" } },
  ),
  "schedule/timeline": records,

  "show/call_sheets": source("app.call_sheets", ["day", "published_at", "project_id"]),
  "show/day_sheets": source("app.day_sheets", ["day", "published_at", "project_id"]),
  "show/run_of_show": runsOfShow,

  "site_ops/guest_check_in": guests,
  "site_ops/lost_and_found": source("app.lost_found_items", [
    "item_number",
    "category",
    "description",
    "item_state",
    "found_at",
    "found_location",
    "storage_location",
    "project_id",
  ]),
  "site_ops/occupancy": source("app.occupancy_counters", [
    "name",
    "current_count",
    "permitted_load",
    "alert_level_percent",
    "load_basis",
    "closed_at",
    "project_id",
  ]),

  "vendors/classes": source("app.vendor_classes", ["name", "std_vendor_class_id", "description"]),
  "vendors/directory": source("app.vendors", [
    "counterparty_id",
    "vendor_state",
    "payment_terms_days",
    "default_currency_code",
    "default_account_code",
  ]),
  "vendors/insurance_certificates": source("app.insurance_certificates", [
    "vendor_id",
    "coverage_type",
    "insurer",
    "policy_identifier",
    "coverage_limit_minor",
    "currency_code",
    "valid_from",
    "valid_to",
  ]),
  "vendors/prequalification": source("app.prequalifications", [
    "vendor_id",
    "scope_note",
    "decision",
    "decided_at",
    "valid_to",
    "created_at",
  ]),
  "vendors/scorecards": source("app.vendor_scorecards", [
    "vendor_id",
    "project_id",
    "period_end",
    "quality_score",
    "delivery_score",
    "safety_score",
  ]),
  "vendors/sponsor_entitlements": source("app.sponsor_entitlements", [
    "counterparty_id",
    "description",
    "project_id",
    "quantity",
    "due_on",
    "fulfilled_at",
  ]),

  "work/all_records": records,
  "work/by_kind": records,
  "work/punch_lists": source("app.punch_items", [
    "record_id",
    "source_record_id",
    "location_text",
    "zone_id",
    "created_at",
  ]),
  "work/recurring": source("app.record_recurrences", [
    "record_id",
    "rrule",
    "time_zone",
    "until_at",
  ]),
  "work/work_orders": source("app.work_orders", [
    "work_order_number",
    "title",
    "work_order_state",
    "budget_minor",
    "currency_code",
    "bid_due_at",
    "scheduled_starts_at",
    "project_id",
  ]),
};

/** The entry of a collection key; custom object pages share one. Null for a collection without one. */
/**
 * Collections that render the view switcher but offer no export, each with its reason. The catalog test reads
 * this list instead of asking these pages for a source.
 */
export const NOT_EXPORTED: Readonly<Record<string, string>> = {
  // ADR 0033 decision 57: nobody is told who reported, and the queue reads through content_moderation_queue,
  // which shows a moderator what they need to decide and nothing to carry away.
  "people/moderation":
    "Reported content stays in the moderation queue; an export would carry it out.",
};

export function exportEntryFor(collectionKey: string | null): ExportEntry | null {
  if (collectionKey === null) return null;
  if (collectionKey.startsWith("objects/")) return EXPORT_SOURCES["objects/*"] ?? null;
  return EXPORT_SOURCES[collectionKey] ?? null;
}

/** The source the page shows now: its own, or its section's (the query key, else the page's default). */
export function exportSourceFor(
  collectionKey: string | null,
  search: URLSearchParams,
): ExportSource | null {
  const entry = exportEntryFor(collectionKey);
  if (entry === null) return null;
  if (!("options" in entry)) return entry;
  const asked = search.get(entry.param) ?? "";
  return entry.options[asked] ?? entry.options[entry.fallback] ?? null;
}

/** Every source of every collection, sections included: what the catalog tests check. */
export function allExportSources(): readonly ExportSource[] {
  return Object.values(EXPORT_SOURCES).flatMap((entry) =>
    "options" in entry ? Object.values(entry.options) : [entry],
  );
}

/**
 * A filter of an export before its values are resolved: an equality or list of values on a column (a
 * project key in a `resolve: "project"` filter becomes the project's id), whether a column is unset or
 * set, or the search box.
 */
export type PlannedFilter =
  | {
      readonly operator: "eq" | "in";
      readonly column: string;
      readonly value: string;
      readonly resolve?: "project";
    }
  | { readonly operator: "is_null" | "not_null"; readonly column: string }
  | { readonly operator: "search"; readonly value: string };

export interface ExportPlan {
  readonly filters: readonly PlannedFilter[];
  /** The project key in the path of a project tab, whose id scopes the rows. */
  readonly projectKey: string | null;
  /** The object key in the path of a custom object page, whose type scopes the rows. */
  readonly objectKey: string | null;
}

/**
 * What an export of the page reads besides its columns: the filters the page applies itself (those on
 * whether a column is set as the query asks, else as the page does by default), the project or
 * object in its path, the URL's filters the source names (a comma-separated value is a list) and the
 * search box. Null when the path lacks the project or object the source is scoped to.
 */
export function planExport(
  source: ExportSource,
  pathname: string,
  search: URLSearchParams,
): ExportPlan | null {
  const segments = pathname.split("/").filter(Boolean);
  const projectKey = source.project ? (segments[1] === "p" ? (segments[2] ?? null) : null) : null;
  const objectKey = source.objectType
    ? segments[1] === "objects" && segments[2]
      ? decodeURIComponent(segments[2])
      : null
    : null;
  if ((source.project && !projectKey) || (source.objectType && !objectKey)) return null;
  const filters: PlannedFilter[] = Object.entries(source.fixed).map(([column, value]) => ({
    operator: "eq" as const,
    column,
    value,
  }));
  for (const spec of source.presence) {
    const asked = search.get(spec.param);
    const shown =
      asked !== null && Object.hasOwn(spec.options, asked)
        ? (spec.options[asked] ?? spec.fallback)
        : spec.fallback;
    if (shown === "unset") filters.push({ operator: "is_null", column: spec.column });
    else if (shown === "set") filters.push({ operator: "not_null", column: spec.column });
  }
  for (const filter of queryToView(search, search.get("view") ?? "").filters) {
    const spec = source.filters[filter.field];
    if (!spec) continue;
    if (spec.resolve) {
      filters.push({
        operator: "eq",
        column: spec.column,
        value: filter.value,
        resolve: spec.resolve,
      });
    } else {
      filters.push({
        operator: filter.value.includes(",") ? "in" : "eq",
        column: spec.column,
        value: filter.value,
      });
    }
  }
  const q = search.get("q")?.trim();
  if (q) filters.push({ operator: "search", value: q.slice(0, 200) });
  return { filters, projectKey, objectKey };
}
