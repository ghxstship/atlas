/**
 * Settings and platform resources (Sections 4.2 Settings and Reports, 4.6, 4.10, 7.3 and 8).
 */
import { z } from "zod";
import * as f from "../common/fields.ts";
import {
  Classification,
  ExportFormat,
  ImportRowState,
  OrgRole,
  SettingScope,
  SpendDocumentType,
} from "../common/enums.ts";
import { MoneyTotal } from "../common/envelope.ts";
import { defineResource } from "../common/resource.ts";

// Tenancy and white label

export const Workspace = defineResource({
  name: "Workspace",
  table: "app.workspaces",
  description: "A workspace inside an organization.",
  fields: { name: f.text("Workspace name.", "Festivals"), slug: f.code("URL slug.", "festivals") },
});

export const WorkspaceMember = defineResource({
  name: "WorkspaceMember",
  table: "app.workspace_members",
  description: "A member of a workspace.",
  immutable: ["workspace_id", "person_id"],
  fields: { workspace_id: f.ref("workspace"), person_id: f.ref("member") },
});

export const Team = defineResource({
  name: "Team",
  table: "app.teams",
  description: "A working group, distinct from canon teams.",
  fields: { name: f.text("Team name.", "Show Control") },
});

export const TeamMember = defineResource({
  name: "TeamMember",
  table: "app.team_members",
  description: "A member of a team.",
  immutable: ["team_id", "person_id"],
  fields: { team_id: f.ref("team"), person_id: f.ref("member") },
});

export const OrgBranding = defineResource({
  name: "OrgBranding",
  table: "app.org_branding",
  description: "White label brand settings for Atlas, Gateway, email and Compass.",
  fields: {
    display_name: f.text("Brand display name.", "Northwind Live"),
    logo_document_id: f.ref("logo file").nullable(),
    accent_token: f.code("Accent color token.", "brand.accent"),
    gateway_domain: f.text("Custom Gateway domain.", "gateway.northwindlive.example").nullable(),
  },
});

export const OrgLegalEntity = defineResource({
  name: "OrgLegalEntity",
  table: "app.org_legal_entities",
  description: "A legal entity of the organization with its fiscal settings.",
  restricted: ["tax_identifier"],
  fields: {
    legal_name: f.text("Legal name.", "Northwind Live LLC"),
    country: f.countryCode(),
    tax_identifier: f.code("Tax identifier.", "123456789").nullable(),
    fiscal_year_start_month: f.int("Fiscal year start month.", 1, 1),
    base_currency: f.currency("Base currency."),
  },
});

export const OrgIpAllowlistEntry = defineResource({
  name: "OrgIpAllowlistEntry",
  table: "app.org_ip_allowlist",
  description: "An allowed network for Atlas and the API.",
  fields: {
    cidr: f.text("CIDR block.", "203.0.113.0/24"),
    label: f.text("Label.", "Office"),
  },
});

// Access

export const Role = defineResource({
  name: "Role",
  table: "app.roles",
  description: "A role: a platform role or an org custom role built from the capability set.",
  fields: {
    name: f.text("Role name.", "Finance Approver"),
    base_role: OrgRole.nullable(),
    description: f
      .longText("What the role is for.", "Approves purchase orders up to the spend limit.")
      .nullable(),
  },
});

export const Capability = defineResource({
  name: "Capability",
  table: "app.capabilities",
  description: "A capability from `packages/schemas/capabilities.yaml`. Read-only.",
  base: "view",
  fields: {
    capability: f.code("Capability verb.", "finance.po.approve"),
    group: f.code("Capability group; OAuth scopes map one to one to groups.", "finance"),
    classification: Classification.nullable(),
  },
});

export const RoleCapability = defineResource({
  name: "RoleCapability",
  table: "app.role_capabilities",
  description: "A capability granted to a role.",
  immutable: ["role_id", "capability"],
  fields: { role_id: f.ref("role"), capability: f.code("Capability verb.", "finance.po.approve") },
});

export const UserCapabilityGrant = defineResource({
  name: "UserCapabilityGrant",
  table: "app.user_capability_grants",
  description:
    "A time-boxed capability grant to a person. A person cannot grant themselves a capability.",
  immutable: ["person_id", "capability"],
  fields: {
    person_id: f.ref("grantee"),
    capability: f.code("Capability verb.", "crew.timesheet.approve"),
    valid_from: f.instant("Start of the grant."),
    valid_to: f.instant("End of the grant.").nullable(),
  },
});

export const RecordGrant = defineResource({
  name: "RecordGrant",
  table: "app.record_grants",
  description: "A grant on specific records, with scope and expiry.",
  fields: {
    grantee_urn: f.text(
      "URN of the grantee.",
      "urn:xpms:person:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    subject_urn: f.text(
      "URN of the record.",
      "urn:xpms:project:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    capability: f.code("Capability verb.", "records.read"),
    valid_to: f.instant("End of the grant.").nullable(),
  },
});

export const Delegation = defineResource({
  name: "Delegation",
  table: "app.delegations",
  description: "A time-boxed delegation of approvals from one person to another.",
  fields: {
    from_person_id: f.ref("delegating person"),
    to_person_id: f.ref("delegate"),
    valid_from: f.instant("Start."),
    valid_to: f.instant("End."),
  },
});

export const SpendAuthority = defineResource({
  name: "SpendAuthority",
  table: "app.spend_authority",
  description: "A spend limit by role or person and document type, enforced in the approval RPCs.",
  fields: {
    role_id: f.ref("role").nullable(),
    person_id: f.ref("person").nullable(),
    document_type: SpendDocumentType,
    limit_minor: f.money("Single-approver limit in the org currency.", 2500000),
    dual_approval_above_minor: f.money("Amount above which two approvers are required.", 10000000),
    currency: f.currency(),
  },
});

export const SeparationOfDutiesRule = defineResource({
  name: "SeparationOfDutiesRule",
  table: "app.separation_of_duties_rules",
  description: "A separation of duties rule. Orgs may tighten defaults but never remove them.",
  serverSet: ["is_default"],
  fields: {
    rule: f.code("Rule key, named in refusals.", "sod.po.creator_cannot_approve"),
    enforced_on: f.text("What the rule is enforced on.", "Purchase orders"),
    is_default: f.bool("Whether it is a platform default that cannot be removed.", true),
  },
});

export const ColumnClassification = defineResource({
  name: "ColumnClassification",
  table: "app.column_classifications",
  description: "The classification of one column in the column registry.",
  base: "view",
  fields: {
    table_name: f.code("Schema-qualified table.", "app.pay_rates"),
    column_name: f.code("Column.", "rate_minor"),
    classification: Classification,
    reveal_capability: f
      .code("Capability that unmasks it.", "data.restricted.read.payroll")
      .nullable(),
  },
});

export const AccessReviewCampaign = defineResource({
  name: "AccessReviewCampaign",
  table: "app.access_review_campaigns",
  description: "A quarterly access review campaign.",
  serverSet: ["campaign_state"],
  fields: {
    name: f.text("Campaign name.", "Q4 Access Review"),
    due_on: f.date("Due date."),
    auto_remove_unreviewed: f.bool("Remove access left unreviewed after 14 days.", false),
    campaign_state: f.stateLabel("Campaign state.", "Active"),
  },
});

export const AccessReviewItem = defineResource({
  name: "AccessReviewItem",
  table: "app.access_review_items",
  description: "One membership role to confirm or remove.",
  immutable: ["access_review_campaign_id", "membership_role_id"],
  fields: {
    access_review_campaign_id: f.ref("campaign"),
    membership_role_id: f.ref("membership role"),
    decision: f.stateLabel("Decision.", "Confirmed").nullable(),
  },
});

export const BreakGlassSession = defineResource({
  name: "BreakGlassSession",
  table: "app.break_glass_sessions",
  description:
    "One hour of emergency full access for an Owner. Requires MFA and a reason; every Admin is notified.",
  serverSet: ["person_id", "started_at", "expires_at"],
  fields: {
    person_id: f.ref("Owner"),
    reason: f.longText("Written reason.", "Payroll export failed during show day."),
    started_at: f.instant("Start."),
    expires_at: f.instant("End, one hour after start."),
  },
});

export const ProjectShare = defineResource({
  name: "ProjectShare",
  table: "app.project_shares",
  description: "A project shared with a partner org, mapping its roles onto project roles.",
  immutable: ["project_id", "partner_organization_id"],
  fields: {
    project_id: f.ref("project"),
    partner_organization_id: f.ref("partner organization"),
    valid_to: f.instant("End of the share.").nullable(),
  },
});

export const ScimGroupMapping = defineResource({
  name: "ScimGroupMapping",
  table: "app.scim_group_mappings",
  description: "An identity-provider group mapped to a role or team.",
  fields: {
    idp_group: f.text("Identity-provider group name.", "event-finance"),
    role_id: f.ref("role").nullable(),
    team_id: f.ref("team").nullable(),
  },
});

export const ApiKey = defineResource({
  name: "ApiKey",
  table: "app.api_keys",
  description:
    "An org-scoped API key with capability scopes and expiry. The secret is shown once and stored hashed.",
  serverSet: ["prefix", "last_used_at", "revoked_at"],
  fields: {
    name: f.text("Key name.", "Accounting Sync"),
    service_account_id: f.ref("service account").nullable(),
    scopes: z.array(z.string().min(1)).meta({
      description: "Capability groups the key may use.",
      example: ["finance"],
    }),
    expires_at: f.instant("Expiry."),
    prefix: f.code("Visible key prefix.", "xos_live_7Hq2"),
    last_used_at: f.instant("Last use.").nullable(),
    revoked_at: f.instant("When it was revoked.").nullable(),
  },
});

export const ApiKeySecret = z
  .object({
    api_key_id: f.ref("API key"),
    secret: z.string().min(1).meta({
      description: "The full key. Shown once; only its hash is stored.",
      example: "xos_live_7Hq2wQ1nC8vL0pR4tY6u",
    }),
  })
  .meta({ id: "ApiKeySecret", description: "A newly created API key secret, shown once." });

export const ServiceAccount = defineResource({
  name: "ServiceAccount",
  table: "app.service_accounts",
  description: "A non-human member with its own audit identity.",
  fields: {
    name: f.text("Service account name.", "Ledger Export Bot"),
    owner_person_id: f.ref("owner"),
    expires_at: f.instant("Expiry.").nullable(),
  },
});

export const OauthApp = defineResource({
  name: "OauthApp",
  table: "app.oauth_apps",
  description: "An OAuth 2.1 client using PKCE.",
  serverSet: ["client_id"],
  fields: {
    name: f.text("App name.", "Show Planner"),
    client_id: f.code("OAuth client identifier.", "xos_client_31f9"),
    redirect_uri: f.url("Registered redirect URI."),
  },
});

export const OauthGrant = defineResource({
  name: "OauthGrant",
  table: "app.oauth_grants",
  description: "A user's consent grant to an OAuth app. Revocable.",
  serverSet: ["oauth_app_id", "person_id", "granted_at"],
  fields: {
    oauth_app_id: f.ref("OAuth app"),
    person_id: f.ref("granting person"),
    scopes: z
      .array(z.string().min(1))
      .meta({ description: "Granted capability groups.", example: ["records"] }),
    granted_at: f.instant("When consent was given."),
  },
});

export const Integration = defineResource({
  name: "Integration",
  table: "app.integrations",
  description: "An integration connection. Credentials are Vault references and never returned.",
  immutable: ["provider"],
  serverSet: ["sync_status", "last_synced_at"],
  fields: {
    provider: f.code("Provider.", "xero"),
    enabled: f.bool("Whether the integration is on.", true),
    sync_status: f.stateLabel("Integration sync status.", "Healthy"),
    last_synced_at: f.instant("Last successful sync.").nullable(),
  },
});

export const WebhookEndpoint = defineResource({
  name: "WebhookEndpoint",
  table: "app.webhook_endpoints",
  description:
    "A webhook endpoint. Deliveries are signed with HMAC-SHA256 and retried for 72 hours.",
  fields: {
    url: f.url("HTTPS endpoint URL."),
    events: z.array(z.string().regex(/^[a-z_]+\.[a-z_]+$/)).meta({
      description: "Subscribed event names.",
      example: ["record.state_changed", "po.approved"],
    }),
    enabled: f.bool("Whether deliveries are sent.", true),
  },
});

export const WebhookDelivery = defineResource({
  name: "WebhookDelivery",
  table: "app.webhook_deliveries",
  description: "A webhook delivery attempt, replayable from Atlas.",
  serverSet: [
    "webhook_endpoint_id",
    "event",
    "delivery_status",
    "attempt",
    "response_status",
    "delivered_at",
  ],
  fields: {
    webhook_endpoint_id: f.ref("endpoint"),
    event: f.code("Event name.", "po.approved"),
    delivery_status: f.stateLabel("Delivery status.", "Delivered"),
    attempt: f.int("Attempt number.", 1, 1),
    response_status: f.int("Endpoint HTTP status.", 200).nullable(),
    delivered_at: f.instant("When it was delivered.").nullable(),
  },
});

export const WebhookEventType = defineResource({
  name: "WebhookEventType",
  table: "app.domain_event_types",
  description: "A webhook event from the domain event table.",
  base: "view",
  fields: {
    event: f.code("Event name `{resource}.{event}`.", "record.state_changed"),
    description: f.text("When it fires.", "A record moved to another state."),
  },
});

// Settings registry

export const SettingDefinition = defineResource({
  name: "SettingDefinition",
  table: "app.setting_definitions",
  description: "A setting generated from `settings.yaml`.",
  base: "view",
  fields: {
    setting_key: f.code("Setting key.", "finance.base_currency"),
    scope: SettingScope,
    value_type: f.code("Value type.", "string"),
    edit_capability: f.code("Capability that edits it.", "settings.finance.write"),
    overridable: f.bool("Whether a lower scope may override it.", true),
  },
});

export const SettingValue = defineResource({
  name: "SettingValue",
  table: "app.setting_values",
  description: "A setting value at one scope. The most specific scope wins unless a lock applies.",
  immutable: ["scope_type", "scope_id", "setting_key"],
  fields: {
    scope_type: SettingScope,
    scope_id: f.ref("scope row").nullable(),
    setting_key: f.code("Setting key.", "finance.base_currency"),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .meta({ description: "Typed value.", example: "USD" }),
  },
});

export const SettingLock = defineResource({
  name: "SettingLock",
  table: "app.setting_locks",
  description: "A lock that stops lower scopes from overriding a setting.",
  immutable: ["setting_key"],
  fields: { setting_key: f.code("Setting key.", "security.mfa_required") },
});

// Privacy and audit

export const AuditEvent = defineResource({
  name: "AuditEvent",
  table: "app.audit_events",
  description: "An append-only compliance audit event, retained 7 years.",
  serverSet: ["actor_urn", "action", "subject_urn", "capacity", "occurred_at", "diff"],
  fields: {
    actor_urn: f.text("URN of the actor.", "urn:xpms:person:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f"),
    action: f.code("Action.", "purchase_order.approved"),
    subject_urn: f.text(
      "URN of the subject.",
      "urn:xpms:purchase_order:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    capacity: f.code("Capacity the actor acted in.", "internal"),
    occurred_at: f.instant("When it happened."),
    diff: f.document("Redacted audit diff."),
  },
});

export const ConsentRecord = defineResource({
  name: "ConsentRecord",
  table: "app.consent_records",
  description: "A consent given or withdrawn.",
  base: "global",
  serverSet: ["recorded_at"],
  fields: {
    person_id: f.ref("person"),
    purpose: f.code("Consent purpose.", "marketing_email"),
    granted: f.bool("Whether consent is granted.", true),
    recorded_at: f.instant("When it was recorded."),
  },
});

export const DsarRequest = defineResource({
  name: "DsarRequest",
  table: "app.dsar_requests",
  description: "A data subject access request.",
  serverSet: ["dsar_state", "completed_at"],
  fields: {
    person_id: f.ref("data subject"),
    request_type: f.code("Request type.", "access"),
    dsar_state: f.stateLabel("Request state.", "In Review"),
    completed_at: f.instant("When it completed.").nullable(),
  },
});

export const RetentionPolicy = defineResource({
  name: "RetentionPolicy",
  table: "app.retention_policies",
  description: "Retention of soft-deleted rows per table.",
  base: "view",
  fields: {
    table_name: f.code("Table.", "app.activity_events"),
    retention_days: f.int("Days kept after soft delete.", 548, 1),
  },
});

export const OrgExport = defineResource({
  name: "OrgExport",
  table: "app.org_exports",
  description: "A full organization export.",
  serverSet: ["export_state", "document_id"],
  fields: {
    format: ExportFormat,
    export_state: f.stateLabel("Export state.", "Complete"),
    document_id: f.ref("export file").nullable(),
  },
});

// Custom objects and fields

export const CustomObjectType = defineResource({
  name: "CustomObjectType",
  table: "app.custom_object_types",
  description: "A custom object type with its own API routes at `/objects/{objectKey}`.",
  immutable: ["object_key"],
  fields: {
    object_key: f.code("Object key used in the route.", "sponsor_activation"),
    label: f.text("Title Case label.", "Sponsor Activation"),
    icon: f.code("Icon name.", "sparkles"),
    default_view: f.code("Default view type.", "table"),
  },
});

export const CustomObjectField = defineResource({
  name: "CustomObjectField",
  table: "app.custom_object_fields",
  description: "A typed field of a custom object type.",
  immutable: ["custom_object_type_id", "field_key"],
  fields: {
    custom_object_type_id: f.ref("custom object type"),
    field_key: f.code("Field key.", "activation_date"),
    label: f.text("Field label.", "Activation Date"),
    data_type: f.code("Data type.", "date"),
    required: f.bool("Whether a value is required.", false),
    filterable: f.bool("Whether the field gets a partial index.", true),
  },
});

export const CustomObjectRecord = defineResource({
  name: "CustomObjectRecord",
  table: "app.custom_object_records",
  description: "A record of a custom object. Values are stored one row per field, never as JSON.",
  fields: {
    title: f.text("Record title.", "Harbor Lounge Activation"),
    values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).meta({
      description: "Field values keyed by field key. Stored normalized in `custom_object_values`.",
      example: { activation_date: "2026-10-08" },
    }),
  },
});

export const CustomObjectRelation = defineResource({
  name: "CustomObjectRelation",
  table: "app.custom_object_relations",
  description: "A relation from a custom object record to another record.",
  immutable: ["custom_object_record_id", "target_urn"],
  fields: {
    custom_object_record_id: f.ref("custom object record"),
    target_urn: f.text(
      "URN of the related record.",
      "urn:xpms:project:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
  },
});

export const CustomFieldDefinition = defineResource({
  name: "CustomFieldDefinition",
  table: "app.custom_field_definitions",
  description: "A custom field on a built-in resource.",
  immutable: ["target_table", "field_key"],
  fields: {
    target_table: f.code("Table the field extends.", "app.vendors"),
    field_key: f.code("Field key.", "union_signatory"),
    label: f.text("Label.", "Union Signatory"),
    data_type: f.code("Data type.", "boolean"),
  },
});

export const CustomFieldValue = defineResource({
  name: "CustomFieldValue",
  table: "app.custom_field_values",
  description: "A custom field value for one row.",
  immutable: ["custom_field_definition_id", "row_id"],
  fields: {
    custom_field_definition_id: f.ref("custom field definition"),
    row_id: f.ref("extended row"),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .nullable()
      .meta({ description: "Typed value.", example: true }),
  },
});

export const OrgStateLabel = defineResource({
  name: "OrgStateLabel",
  table: "app.org_state_labels",
  description: "An org's display relabel of a record state. It never mints a new lifecycle.",
  immutable: ["record_state"],
  fields: {
    record_state: f.stateLabel("Record state relabeled.", "In Review"),
    label: f.text("Display label.", "With Client"),
  },
});

// Import and export

export const ImportJob = defineResource({
  name: "ImportJob",
  table: "app.import_jobs",
  description:
    "A spreadsheet import through detect, map, validate, deduplicate, dry run and commit.",
  serverSet: ["import_state", "import_batch_id"],
  fields: {
    source_document_id: f.ref("uploaded spreadsheet"),
    target_table: f.code("Target entity.", "app.vendors"),
    import_mapping_profile_id: f.ref("saved mapping profile").nullable(),
    import_state: f.stateLabel("Import job state.", "In Review"),
    import_batch_id: f.ref("committed batch").nullable(),
  },
});

export const ImportBatch = defineResource({
  name: "ImportBatch",
  table: "app.import_batches",
  description:
    "A committed import batch. It can be undone within 7 days unless later edits depend on it.",
  serverSet: ["import_job_id", "committed_at", "undone_at", "row_count"],
  fields: {
    import_job_id: f.ref("import job"),
    committed_at: f.instant("When the batch was committed."),
    undone_at: f.instant("When the batch was undone.").nullable(),
    row_count: f.int("Rows written.", 212),
  },
});

export const ImportRowResult = defineResource({
  name: "ImportRowResult",
  table: "app.import_row_results",
  description: "The validation result of one imported row, with a reason per cell.",
  serverSet: ["import_job_id", "source_row", "row_state", "reason"],
  fields: {
    import_job_id: f.ref("import job"),
    source_row: f.int("Source row number.", 14, 1),
    row_state: ImportRowState,
    reason: f.text("Why the row is invalid or refused.", "Unknown counterparty type.").nullable(),
  },
});

export const ImportMappingProfile = defineResource({
  name: "ImportMappingProfile",
  table: "app.import_mapping_profiles",
  description: "A saved column-to-field mapping for one-click repeat imports.",
  fields: {
    name: f.text("Profile name.", "Vendor List From Accounting"),
    target_table: f.code("Target entity.", "app.vendors"),
  },
});

export const MergeReview = defineResource({
  name: "MergeReview",
  table: "app.merge_reviews",
  description: "A fuzzy duplicate awaiting review. Fuzzy matches never merge automatically.",
  serverSet: ["import_job_id", "candidate_urn", "existing_urn", "similarity"],
  fields: {
    import_job_id: f.ref("import job"),
    candidate_urn: f.text(
      "URN of the incoming row.",
      "urn:xpms:import_row:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    existing_urn: f.text(
      "URN of the existing row.",
      "urn:xpms:vendor:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    similarity: f.quantity("Similarity score, 0.85 or higher.", 0.91),
    decision: f.stateLabel("Reviewer decision.", "Merge").nullable(),
  },
});

export const ExportJob = defineResource({
  name: "ExportJob",
  table: "app.export_jobs",
  description: "An export of a list or report, subject to data loss prevention rules.",
  serverSet: ["export_state", "document_id"],
  fields: {
    source: f.text(
      "What is exported, as a saved view or report URN.",
      "urn:xpms:saved_view:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    format: ExportFormat,
    export_state: f.stateLabel("Export state.", "Complete"),
    document_id: f.ref("export file").nullable(),
  },
});

// Reports and views

export const ReportDefinition = defineResource({
  name: "ReportDefinition",
  table: "app.report_definitions",
  description: "A report definition with NULL-aware aggregates. Reports respect RLS and masking.",
  fields: {
    name: f.text("Report name.", "Labor by Department"),
    source: f.code("Source.", "crew"),
    definition: f.document("Fields, filters, grouping and chart type."),
  },
});

export const ReportRun = defineResource({
  name: "ReportRun",
  table: "app.report_runs",
  description: "A run of a report definition.",
  immutable: ["report_definition_id"],
  serverSet: ["run_state", "document_id", "ran_at"],
  fields: {
    report_definition_id: f.ref("report definition"),
    format: ExportFormat,
    run_state: f.stateLabel("Run state.", "Complete"),
    document_id: f.ref("output file").nullable(),
    ran_at: f.instant("When the run finished.").nullable(),
  },
});

export const ReportSchedule = defineResource({
  name: "ReportSchedule",
  table: "app.report_schedules",
  description: "A scheduled email delivery of a report to org members only.",
  immutable: ["report_definition_id"],
  fields: {
    report_definition_id: f.ref("report definition"),
    rrule: f.text("RFC 5545 recurrence rule.", "FREQ=WEEKLY;BYDAY=MO"),
    format: ExportFormat,
    time_zone: f.timeZone(),
  },
});

export const Dashboard = defineResource({
  name: "Dashboard",
  table: "app.dashboards",
  description: "A grid of report tiles, saved per user or per team.",
  fields: {
    name: f.text("Dashboard name.", "Show Week"),
    team_id: f.ref("team").nullable(),
  },
});

export const DashboardTile = defineResource({
  name: "DashboardTile",
  table: "app.dashboard_tiles",
  description: "A report tile on a dashboard.",
  immutable: ["dashboard_id"],
  fields: {
    dashboard_id: f.ref("dashboard"),
    report_definition_id: f.ref("report definition"),
    position: f.int("Tile order.", 1, 1),
    width: f.int("Grid columns spanned.", 6, 1),
  },
});

export const SavedView = defineResource({
  name: "SavedView",
  table: "app.saved_views",
  description: "A saved view of a collection: filters, sort, grouping and view type.",
  fields: {
    collection: f.code("Collection key.", "records"),
    name: f.text("View name.", "Blocked Permits This Month"),
    view_type: f.code("View type from `views.yaml`.", "table"),
    query: f.text("Query in the filter grammar.", "filter[record_state][eq]=Blocked"),
    shared: f.bool("Whether the view is shared with the org.", false),
  },
});

export const ReportRow = defineResource({
  name: "ReportRow",
  table: "app.mv_reports",
  description: "A row of a built-in analytics report. Money columns are NULL-aware totals.",
  base: "view",
  fields: {
    dimension: f.text("Grouping value, such as a GL account or URID.", "5400"),
    budget: MoneyTotal,
    actual: MoneyTotal,
  },
});

// Workflow

export const ApprovalPolicy = defineResource({
  name: "ApprovalPolicy",
  table: "app.approval_policies",
  description: "An approval policy with ordered steps.",
  fields: {
    name: f.text("Policy name.", "PO Over Limit"),
    document_type: SpendDocumentType,
  },
});

export const ApprovalInstance = defineResource({
  name: "ApprovalInstance",
  table: "app.approval_instances",
  description: "An approval in flight for one subject.",
  serverSet: ["approval_state", "requested_by"],
  fields: {
    approval_policy_id: f.ref("approval policy"),
    subject_urn: f.text(
      "URN of the subject.",
      "urn:xpms:purchase_order:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    requested_by: f.ref("requester"),
    approval_state: f.stateLabel("Approval state.", "In Review"),
  },
});

export const ApprovalDecision = defineResource({
  name: "ApprovalDecision",
  table: "app.approval_decisions",
  description: "A decision by an eligible approver, never the requester.",
  immutable: ["approval_instance_id"],
  serverSet: ["approver_id", "decided_at"],
  fields: {
    approval_instance_id: f.ref("approval instance"),
    approved: f.bool("Whether the step is approved.", true),
    comment: f.longText("Decision comment.", "Within budget.").nullable(),
    approver_id: f.ref("approver"),
    decided_at: f.instant("When it was decided."),
  },
});

export const CommentThread = defineResource({
  name: "CommentThread",
  table: "app.comment_threads",
  description: "A comment thread on any record.",
  immutable: ["subject_urn"],
  fields: {
    subject_urn: f.text(
      "URN of the commented record.",
      "urn:xpms:record:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    resolved: f.bool("Whether the thread is resolved.", false),
  },
});

export const Comment = defineResource({
  name: "Comment",
  table: "app.comments",
  description: "A comment in a thread.",
  immutable: ["comment_thread_id"],
  serverSet: ["author_id"],
  fields: {
    comment_thread_id: f.ref("thread"),
    body: f.document("Comment body as a rich text document."),
    author_id: f.ref("author"),
  },
});

export const Notification = defineResource({
  name: "Notification",
  table: "app.notifications",
  description: "A notification for the caller.",
  serverSet: ["kind", "subject_urn", "created_for", "deep_link"],
  fields: {
    kind: f.code("Notification kind from `notification-kinds.yaml`.", "timesheet.approved"),
    subject_urn: f.text(
      "URN of the subject.",
      "urn:xpms:timesheet:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    created_for: f.ref("recipient"),
    deep_link: f.text("Path to open.", "/crew/timesheets/0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f"),
    read_at: f.instant("When it was read.").nullable(),
  },
});

export const NotificationPreference = defineResource({
  name: "NotificationPreference",
  table: "app.notification_preferences",
  description: "A per-kind, per-channel notification preference.",
  base: "global",
  immutable: ["kind", "channel"],
  fields: {
    kind: f.code("Notification kind.", "timesheet.approved"),
    channel: f.code("Delivery channel.", "push"),
    enabled: f.bool("Whether the channel is on for the kind.", true),
  },
});

export const CalendarFeed = defineResource({
  name: "CalendarFeed",
  table: "app.calendar_feeds",
  description: "An iCalendar feed. The token is shown once, stored hashed and revocable.",
  serverSet: ["revoked_at"],
  fields: {
    project_id: f.ref("project").nullable(),
    revoked_at: f.instant("When it was revoked.").nullable(),
  },
});

export const TrashItem = defineResource({
  name: "TrashItem",
  table: "app.trash_items",
  description:
    "A soft-deleted row, restorable for its table's retention period. A view, not a copy.",
  base: "view",
  fields: {
    subject_urn: f.text(
      "URN of the deleted row.",
      "urn:xpms:record:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
    ),
    deleted_at: f.instant("When it was deleted."),
    purge_after: f.instant("When it will be purged."),
  },
});

export const Template = defineResource({
  name: "Template",
  table: "app.templates",
  description: "A project or record template, including the XOS 4.0 Production Template copy.",
  fields: {
    name: f.text("Template name.", "Three-Day Festival"),
    current_version_id: f.ref("current version").nullable(),
  },
  serverSet: ["current_version_id"],
});

export const TemplateApplication = defineResource({
  name: "TemplateApplication",
  table: "app.template_applications",
  description: "A template applied to create a project and its records.",
  serverSet: ["project_id"],
  fields: {
    template_id: f.ref("template"),
    project_id: f.ref("created project"),
  },
});

export const AiSettings = defineResource({
  name: "AiSettings",
  table: "app.ai_settings",
  description: "AI feature switches. Every feature is off until an Admin turns it on.",
  fields: {
    assistant_enabled: f.bool("Assistant.", false),
    extraction_enabled: f.bool("Document extraction.", false),
    drafting_enabled: f.bool("Drafting.", false),
  },
});

export const ConfirmRequest = z
  .object({
    confirm: z
      .literal(true)
      .meta({ description: "Explicit confirmation of an irreversible action.", example: true }),
  })
  .meta({ id: "ConfirmRequest", description: "Confirmation for an irreversible action." });
