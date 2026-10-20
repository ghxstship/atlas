/**
 * The last 56 Playbook field targets with no API field (finding A54-002), exposed by A63 (RRR-108) through ADR 0023
 * corrections and three read resources. `canon/import/test/field-targets-openapi.test.ts` checks that every
 * Playbook `field` target is returned by a resource of its table, or that its column map entry names the field
 * that returns it (`api: Exposed as ...`).
 *
 * - Canon columns the canon resources left out are added to their read shapes (the generic table handlers select
 *   the read shape, so no handler names them), and the Emergency Codes protocols become a canon resource.
 * - Views and ledgers are read-only fields on the resource they describe, filled once per page by the handler
 *   (`enrich` in handlers/support/table.ts): a budget line's actual spend and GL account, a change order's approval,
 *   a purchase order's issue date and invoiced and paid amounts, an incident's close, a time entry's meal break, a
 *   record's assignees, progress, permit and inspection result, and a vendor's bank account.
 * - Real columns of a resource's own table are added where the frozen shape left them out (engagements, profiles).
 * - The department calls of a cue (app.cue_calls, 1180) and a project's authorities (app.project_authority) become
 *   resources of their own.
 *
 * Every added field is nullable. Each module spreads its own list into its module file.
 */
import { z } from "@hono/zod-openapi";
import { canonCodes, defineResource, fields } from "@xos/schemas";
import type { CapabilityRule } from "../../capabilities.ts";
import type { CorrectionInput } from "../../corrections.ts";
import { editDefinition, editShape, orNull } from "../../correct.ts";
import { resource } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";

const SINCE = "1.0.0-draft.2";
const GATE =
  "Section 18 gate 14 asks that every Playbook field target is returned by the API (finding A54-002).";

/** A read-only field: returned, never accepted. */
const read = (schema: z.ZodType) => ({ schema: orNull(schema) });
/** A nullable column the update body accepts and the read shape returns; the create body stays as frozen. */
const updatable = (schema: z.ZodType) => ({ schema: orNull(schema), update: true });
const cell = (description: string, example: string, max = 2000) =>
  read(fields.text(description, example, max));

// Activity ---------------------------------------------------------------------------------------------

export const activityFieldExposure: readonly CorrectionInput[] = [
  {
    id: "activity-event-domain-event",
    since: SINCE,
    resources: ["activityEvents"],
    change: "Adds the read-only `domain_event_id`.",
    reason: `app.activity_events (0501) projects one domain event per row (\`domain_event_id\`), which the Activity Log sheet names as its reference. ${GATE}`,
    apply: editShape({
      add: {
        domain_event_id: read(
          fields.ref("domain event the activity row shows, as webhooks and the outbox name it"),
        ),
      },
    }),
  },
];

// Finance ----------------------------------------------------------------------------------------------

export const financeFieldExposure: readonly CorrectionInput[] = [
  {
    id: "budget-line-actual-and-account",
    since: SINCE,
    resources: ["budgetLines"],
    change: "Adds the read-only `actual_minor` and `account_code`.",
    reason: `app.budget_line_facts (0480) derives a line's GL account from its category (Bible tab 31) and its actual spend from the approved and paid expenses posted to it (Section 3.15); the Budget Expenses and PO Line Items sheets restate both. ${GATE}`,
    apply: editShape({
      add: {
        actual_minor: {
          schema: fields.money(
            "Approved and paid expenses posted to the line (app.budget_line_facts); null when unpriced.",
            480000,
          ),
        },
        account_code: read(canonCodes.GlAccountCode),
      },
    }),
  },
  {
    id: "change-order-line-account-and-cost-center",
    since: SINCE,
    resources: ["changeOrderLines"],
    change: "Adds the read-only `account_code` and `cost_center_id`.",
    reason: `app.change_order_line_facts (0480) derives a change order line's GL account from its category and its cost center from the budget line it revises; the Change Orders sheet restates both. ${GATE}`,
    apply: editShape({
      add: {
        account_code: read(canonCodes.GlAccountCode),
        cost_center_id: read(
          fields.ref("cost center (dimension 1) of the budget line the change revises"),
        ),
      },
    }),
  },
  {
    id: "change-order-approval",
    since: SINCE,
    resources: ["changeOrders"],
    change: "Adds the read-only `approved_at` and `approved_by`.",
    reason: `app.change_order_state_transitions (0321) records who moved a change order to Approved and when; the Change Orders sheet names both. ${GATE}`,
    apply: editShape({
      add: {
        approved_at: read(
          fields.instant("When the change order moved to Approved, from its transition ledger."),
        ),
        approved_by: read(fields.ref("person who moved the change order to Approved")),
      },
    }),
  },
];

// Procurement ------------------------------------------------------------------------------------------

export const procurementFieldExposure: readonly CorrectionInput[] = [
  {
    id: "purchase-order-issue-and-invoicing",
    since: SINCE,
    resources: ["purchaseOrders"],
    change: "Adds the read-only `sent_at`, `invoiced_minor` and `paid_minor`.",
    reason: `app.purchase_order_state_transitions (0331) records when an order moved to Sent (its issue date), and app.invoice_totals (0321) the subtotal and applied payments of the invoices matched to it (app.invoice_matches); the Purchase Orders sheet names all three. ${GATE}`,
    apply: editShape({
      add: {
        sent_at: read(
          fields.instant(
            "When the order moved to Sent (its issue date), from its transition ledger.",
          ),
        ),
        invoiced_minor: {
          schema: fields.money(
            "Subtotal of the invoices matched to the order; null when none is matched or one is unpriced.",
            1250000,
          ),
        },
        paid_minor: {
          schema: fields.money(
            "Payments applied to the invoices matched to the order; null when none is matched.",
            600000,
          ),
        },
      },
    }),
  },
];

// Safety -----------------------------------------------------------------------------------------------

export const safetyFieldExposure: readonly CorrectionInput[] = [
  {
    id: "incident-closed-at",
    since: SINCE,
    resources: ["incidents"],
    change: "Adds the read-only `closed_at`.",
    reason: `app.incident_state_transitions (0353) records when an incident moved to Closed; the Incident CAD Log sheet names it the cleared time. ${GATE}`,
    apply: editShape({
      add: {
        closed_at: read(
          fields.instant("When the incident moved to Closed, from its transition ledger."),
        ),
      },
    }),
  },
];

// Crew -------------------------------------------------------------------------------------------------

export const crewFieldExposure: readonly CorrectionInput[] = [
  {
    id: "time-entry-meal-break",
    since: SINCE,
    resources: ["timeEntries"],
    change: "Adds the read-only `meal_out_at` and `meal_in_at`.",
    reason: `app.clock_punches (0365) records a meal break as a Break Start and a Break End punch on the time entry; the Crew Timesheets sheet names both times. ${GATE}`,
    apply: editShape({
      add: {
        meal_out_at: read(
          fields.instant("Effective time of the entry's first Break Start punch (meal out)."),
        ),
        meal_in_at: read(
          fields.instant("Effective time of the entry's last Break End punch (meal in)."),
        ),
      },
    }),
  },
];

// Opportunities ----------------------------------------------------------------------------------------

export const opportunitiesFieldExposure: readonly CorrectionInput[] = [
  {
    id: "engagement-counterparty",
    since: SINCE,
    resources: ["engagements"],
    change: "Adds the read-only `counterparty_id`.",
    reason: `app.engagements (0700) names the counterparty (the vendor) the holder is engaged through; \`organization_id\` is that counterparty's organization. The Credential Issuance sheet names the vendor. ${GATE}`,
    apply: editShape({
      add: {
        counterparty_id: read(
          fields.ref("counterparty (vendor) the holder is engaged through; null when direct"),
        ),
      },
    }),
  },
];

// Identity ---------------------------------------------------------------------------------------------

export const identityFieldExposure: readonly CorrectionInput[] = [
  {
    id: "organization-profile-contact",
    since: SINCE,
    resources: ["organizationProfiles"],
    change: "Adds `website_url` and `contact_email`, nullable, read and accepted on update.",
    reason: `app.organization_profiles (0860) stores the organization's website (https) and contact email (lowercase); the Vendor Directory sheet names both. ${GATE}`,
    apply: editShape({
      add: {
        website_url: updatable(fields.url("Website of the organization; https only.")),
        contact_email: updatable(
          fields.email("Contact email of the organization, stored in lowercase."),
        ),
      },
    }),
  },
  {
    id: "person-profile-preferred-name",
    since: SINCE,
    resources: ["personProfiles"],
    change: "Adds `preferred_name`, nullable, read and accepted on update.",
    reason: `app.person_profiles (0860) stores the name the person goes by; the Personnel Roster sheet names it. ${GATE}`,
    apply: editShape({
      add: {
        preferred_name: updatable(fields.text("Name the person goes by.", "Alex", 100)),
      },
    }),
  },
];

// Work -------------------------------------------------------------------------------------------------

export const workFieldExposure: readonly CorrectionInput[] = [
  {
    id: "record-subtype-facts",
    since: SINCE,
    resources: ["records"],
    change:
      "Adds the read-only `assignee_membership_ids`, `progress_pct`, `permit_identifier` and `inspection_result_enum_id`.",
    reason: `A record's assignees are rows of app.record_assignments (0310), and its subtype facts are columns of app.record_task (progress), app.record_permit (permit identifier) and app.record_inspection (result), all of 0311; the Production Tasks, Work Orders and Inspection Compliance sheets name them. ${GATE}`,
    apply: editShape({
      add: {
        assignee_membership_ids: {
          schema: z.array(fields.ref("membership assigned to the record")).meta({
            description:
              "Memberships assigned to the record (app.record_assignments), oldest first.",
            example: ["0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f"],
          }),
        },
        progress_pct: read(
          z
            .number()
            .min(0)
            .max(100)
            .meta({ description: "Progress of a task record, as a percentage.", example: 40 }),
        ),
        permit_identifier: read(
          fields.text(
            "Permit identifier the authority issued, on a permit record.",
            "BP-2027-0611",
            200,
          ),
        ),
        inspection_result_enum_id: read(
          fields.ref(
            "Inspection Result enumeration row (Standard Library) of an inspection record",
          ),
        ),
      },
    }),
  },
];

// Vendors ----------------------------------------------------------------------------------------------

export const vendorFieldExposure: readonly CorrectionInput[] = [
  {
    id: "vendor-bank-account-last4",
    since: SINCE,
    resources: ["vendors"],
    change: "Adds the read-only `bank_account_last4`.",
    reason: `app.vendor_bank_accounts_masked (0330) shows the last four digits of a vendor's bank account to every vendor reader and masks the rest without data.restricted.read.banking; the Vendor Directory sheet derives its ACH Form column from it. ${GATE}`,
    apply: editShape({
      add: {
        bank_account_last4: read(
          fields
            .text(
              "Last four digits of the vendor's most recent bank account; null when none is on file.",
              "4321",
              4,
            )
            .regex(/^[0-9]{4}$/),
        ),
      },
    }),
  },
];

// Canon ------------------------------------------------------------------------------------------------

const CANON_REASON = (table: string, sheet: string) =>
  `${table} (0101) carries the Playbook ${sheet} sheet's column on the canon row; the canon resource left it out. ${GATE}`;

export const canonFieldExposure: readonly CorrectionInput[] = [
  {
    id: "canon-category-xyz",
    since: SINCE,
    resources: ["canonCategories"],
    change: "Adds the schema family `xyz` (X, Y or Z).",
    reason: CANON_REASON("xpms.dim_category", "Categories & URID Master"),
    apply: editShape({
      add: {
        xyz: read(canonCodes.Xyz),
      },
    }),
  },
  {
    id: "canon-counterparty-type-columns",
    since: SINCE,
    resources: ["canonCounterpartyTypes"],
    change:
      "Adds `classification_code`, `vendor_class`, `clearance_tier` and `default_account_code`.",
    reason: CANON_REASON("xpms.dim_counterparty_type", "Counterparty Types"),
    apply: editShape({
      add: {
        classification_code: read(fields.code("Classification code.", "CP-AVINT")),
        vendor_class: cell("Vendor class.", "Class B", 100),
        clearance_tier: cell("Clearance tier.", "Tier 2 - Technical Lead", 200),
        default_account_code: read(canonCodes.GlAccountCode),
      },
    }),
  },
  {
    id: "canon-department-columns",
    since: SINCE,
    resources: ["canonDepartments"],
    change: "Adds `executive_lead`, `core_function` and `scope`.",
    reason: CANON_REASON("xpms.dim_department", "Departments"),
    apply: editShape({
      add: {
        executive_lead: cell("Executive lead of the department.", "Executive Producer", 200),
        core_function: cell(
          "Core function of the department.",
          "Governance, master project control & compliance",
        ),
        scope: cell("Scope of the department.", "Master operations & overall accountability"),
      },
    }),
  },
  {
    id: "canon-gl-account-normal-balance",
    since: SINCE,
    resources: ["canonGlAccounts"],
    change: "Adds the read-only `normal_balance`.",
    reason: `xpms.dim_gl_account_type (0101) stores the normal balance once per account type; the GL Accounts sheet restates it per account. ${GATE}`,
    apply: editShape({
      add: {
        normal_balance: read(
          z.enum(["Debit", "Credit"]).meta({
            description: "Normal balance of the account's type: Debit or Credit.",
            example: "Debit",
          }),
        ),
      },
    }),
  },
  {
    id: "canon-element-accounts",
    since: SINCE,
    resources: ["canonElements"],
    change: "Adds `purchase_account`, `default_cost_center` and `external_ref`.",
    reason: CANON_REASON("xpms.elements", "Procurement Catalog"),
    apply: editShape({
      add: {
        purchase_account: read(canonCodes.GlAccountCode),
        default_cost_center: read(
          fields.code("Default cost center (dimension 1) of the element.", "CC-CORP"),
        ),
        external_ref: read(
          fields.text(
            "External reference of the element.",
            "TECH-VIDO-CAMR-001 · 5000.050.00",
            200,
          ),
        ),
      },
    }),
  },
  {
    id: "canon-category-gl-account",
    since: SINCE,
    resources: ["canonCategoryGl"],
    change: "Adds the read-only `account_code`.",
    reason: `xpms.v_category_gl (0107) resolves a category's default GL account: the Expense account of its department's class; the Categories & URID Master sheet restates it. ${GATE}`,
    apply: editShape({ add: { account_code: read(canonCodes.GlAccountCode) } }),
  },
  {
    id: "canon-std-document-library-file",
    since: SINCE,
    resources: ["canonStdDocumentLibrary"],
    change: "Adds `organization`, `project`, `file_size` and `storage_url`.",
    reason: CANON_REASON("xpms.std_document_library", "Document & Asset Library").replace(
      "(0101)",
      "(0105)",
    ),
    apply: editShape({
      add: {
        organization: cell("Organization as the sheet names it.", "GHXSTSHIP", 200),
        project: cell("Project as the sheet names it.", "CSMIA26", 200),
        file_size: cell("File size as the sheet gives it.", "48.5 MB", 100),
        storage_url: cell(
          "Where the file is stored, as the sheet gives it.",
          "https://files.example/doc-001.pdf",
        ),
      },
    }),
  },
  {
    id: "canon-std-sop-organization",
    since: SINCE,
    resources: ["canonStdSops"],
    change: "Adds `organization` and `project`.",
    reason: CANON_REASON("xpms.std_sop", "SOP Library").replace("(0101)", "(0105)"),
    apply: editShape({
      add: {
        organization: cell("Organization as the sheet names it.", "GHXSTSHIP", 200),
        project: cell("Project as the sheet names it.", "CSMIA26", 200),
      },
    }),
  },
];

// New resources ----------------------------------------------------------------------------------------

const CueCall = editDefinition(
  defineResource({
    name: "CueCall",
    table: "app.cue_calls",
    description:
      "A department's call on a cue (1180): the audio, lighting, video, special effects or stage instruction given when the cue fires. The Run of Show sheet holds one column per department.",
    fields: {
      cue_id: fields.ref("cue the call belongs to"),
      call_kind: z
        .enum(["Audio", "Lighting", "Video", "Special Effects", "Stage"])
        .meta({ description: "Department making the call.", example: "Lighting" }),
      instruction: fields.text(
        "What the department does on the cue.",
        "LX 14 GO, house to half.",
        2000,
      ),
    },
    immutable: ["cue_id"],
  }),
  { nullable: ["created_by", "updated_by"] },
);

const ProjectAuthority = defineResource({
  name: "ProjectAuthority",
  table: "app.project_authority",
  base: "view",
  description:
    "An authority having jurisdiction over a project: a responder agency of the jurisdiction of the project's venue (xpms.jurisdiction_agency), one row per service and agency. A project without a venue has none.",
  fields: {
    project_id: fields.ref("project"),
    service: fields.text("Responder service the agency provides.", "fire", 100),
    agency: fields.text("Agency having jurisdiction.", "Miami-Dade Fire Rescue", 300),
    contact: orNull(fields.text("How to reach the agency.", "911", 300)),
  },
});

const EmergencyProtocolStep = z
  .object({
    step_no: fields.int("Step number, from 1.", 1, 1),
    body: fields.text(
      "What to do; responder services appear as tokens such as {fire} (ruling D15).",
      "Contact {fire}.",
      2000,
    ),
  })
  .meta({
    id: "CanonEmergencyProtocolStep",
    description: "One numbered step of an emergency protocol.",
  });

const CanonEmergencyProtocol = defineResource({
  name: "CanonStdEmergencyProtocol",
  table: "xpms.emergency_protocol",
  base: "canon",
  key: "record_key",
  description:
    "An emergency protocol of the Standard Library (Emergency Codes sheet): what one operational domain does when a radio code is called, in numbered steps.",
  fields: {
    record_key: fields.code("Record identifier of the protocol.", "EMG-001"),
    code: fields.code("Radio code the protocol answers (xpms.emergency_code).", "CODE_RED"),
    domain: fields.text("Operational domain the protocol applies to.", "Site Operations", 200),
    department: orNull(fields.text("Department as the sheet names it.", "Security & Safety", 200)),
    category: orNull(fields.text("Category as the sheet names it.", "Emergency Protocols", 200)),
    sub_category: orNull(
      fields.text("Sub-category as the sheet names it.", "Incident Response", 200),
    ),
    steps: z
      .array(EmergencyProtocolStep)
      .meta({ description: "The protocol's steps (xpms.emergency_protocol_step), in order." }),
  },
});

export const cueCallResources: readonly ResourceSpec[] = [resource("Show", "/cue-calls", CueCall)];
export const cueCallCapabilities: Readonly<Record<string, CapabilityRule>> = {
  cueCalls: { read: "show.run_of_show.read", write: "show.run_of_show.write" },
};

export const projectAuthorityResources: readonly ResourceSpec[] = [
  resource("Projects", "/project-authorities", ProjectAuthority, {
    verbs: ["list"],
    order: { by: ["project_id", "service", "agency"], numeric: false },
    label: "project authority",
  }),
];
export const projectAuthorityCapabilities: Readonly<Record<string, CapabilityRule>> = {
  projectAuthorities: { read: "projects.project.read" },
};

export const canonEmergencyProtocolResources: readonly ResourceSpec[] = [
  resource("Canon", "/canon/std/emergency-protocols", CanonEmergencyProtocol, {
    label: "emergency protocol",
  }),
];
