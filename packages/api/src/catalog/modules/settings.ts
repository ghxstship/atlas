/**
 * Settings operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Settings resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen Settings resources follow ADR 0023.
 */
import { z } from "@hono/zod-openapi";
import { fields, platform as pf } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import {
  all,
  editShape,
  orNull,
  putActions,
  removeVerbs,
  setCapabilities,
  setTable,
} from "../correct.ts";
import { collectionAction } from "../define.ts";
import type { ResourceSpec } from "../types.ts";
import {
  aiSettingsActions,
  auroraCapabilities,
  auroraCorrections,
  auroraResources,
} from "./parts/aurora.ts";
import {
  integrationActions,
  integrationCapabilities,
  integrationCorrections,
} from "./parts/settings-integrations.ts";

const label = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

const optional = (schema: z.ZodType) => ({ schema, create: "optional" as const });

const capabilityCode = (description: string) =>
  z
    .string()
    .regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/)
    .meta({ description, example: "finance.po.approve" });

/** An example stored color value for the contract, not a design value of any XOS surface. */
const EXAMPLE_HEX = `${"#"}1F6FEB`;

const hex = (description: string) =>
  orNull(
    z
      .string()
      .regex(/^#[0-9A-F]{6}$/)
      .meta({ description, example: EXAMPLE_HEX }),
  );

const brandPath = (description: string) =>
  optional(
    orNull(fields.text(description, "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f/logo-light.svg", 1024)),
  );

const SCOPE_KINDS = ["organization", "workspace", "team", "project", "record"] as const;

/** The create verb as a collection action at the same path, answering `response` with 201. */
const createAnswering =
  (response: z.ZodType, rpc: string, summary: string, description: string) =>
  (spec: ResourceSpec): ResourceSpec => {
    const body = spec.def.create;
    if (body === undefined) throw new Error(`${spec.op} has no create body.`);
    return putActions([
      collectionAction("create", {
        segment: "",
        summary,
        description,
        body,
        response,
        rpc,
        status: 201,
      }),
    ])(removeVerbs("create")(spec));
  };

const WebhookEndpointSecret = z
  .object({
    webhook_endpoint_id: fields.ref("webhook endpoint"),
    signing_secret: z.string().min(1).meta({
      description:
        "The endpoint's signing secret. Shown once; it is stored in Vault and never read back.",
      example: "whsec_5Jk2pQ8xL1nV7cR3",
    }),
  })
  .meta({
    id: "WebhookEndpointSecret",
    description: "A newly created webhook endpoint and its signing secret, shown once.",
  });

export const additions = defineAdditions("Settings", {
  // Aurora AI (A25): see ./parts/aurora.ts.
  resources: [...auroraResources],
  actions: { aiSettings: aiSettingsActions, ...integrationActions },
  capabilities: { ...auroraCapabilities, ...integrationCapabilities },
  corrections: [
    ...auroraCorrections,
    {
      id: "subscription-state-and-stripe-fields",
      since: "1.0.0-draft.2",
      resources: ["subscriptions"],
      change:
        "`subscription_state` is the database enum (lowercase Stripe states); removes `current_period_end` and `seats`.",
      reason:
        "app.subscriptions (0202, 0560) stores the Stripe subscription status as app.subscription_state (trialing, active, past_due, read_only, canceled), which the Title Case pattern rejects, and keeps period and seat counts in Stripe, not in columns.",
      apply: editShape({
        remove: ["current_period_end", "seats"],
        add: {
          subscription_state: {
            schema: label(
              ["trialing", "active", "past_due", "read_only", "canceled"],
              "Subscription status as Stripe reports it; read_only after the grace period.",
            ),
          },
        },
      }),
    },
    {
      id: "subscription-extra-seats",
      since: "1.0.0-draft.2",
      resources: ["subscriptions"],
      change: "Adds the read-only `extra_seats` and `seats_grandfathered`.",
      reason:
        "Pricing v4 (1250, ADR 0034) gives plans a seat allowance. app.subscriptions.extra_seats holds the seats bought above it, synced from the Stripe quantity of the plan's extra-seat price, and seats_grandfathered marks a subscription that keeps unlimited seats from before seat limits. Both are set only by billing.",
      apply: editShape({
        add: {
          extra_seats: {
            schema: fields.int("Seats bought above the plan's seat allowance.", 3, 0),
          },
          seats_grandfathered: {
            schema: z.boolean().meta({
              description:
                "True when the subscription keeps unlimited seats from before plans had seat limits, until its plan changes.",
              example: false,
            }),
          },
        },
        serverSet: ["extra_seats", "seats_grandfathered"],
      }),
    },
    {
      id: "plan-codes",
      since: "1.0.0-draft.2",
      resources: ["plans"],
      change:
        "`plan_code` becomes `code` and adds `sort_order`; removes `name`, `monthly_price_minor` and `currency`.",
      reason:
        "app.plans (0201) holds the plan code and its order only; plan names come from the i18n catalogs and prices from Stripe (ADR 0018, ADR 0020).",
      apply: editShape({
        rename: { plan_code: "code" },
        remove: ["name", "monthly_price_minor", "currency"],
        add: { sort_order: { schema: fields.int("Plan order from the free plan upward.", 1) } },
      }),
    },
    {
      id: "workspace-member-membership",
      since: "1.0.0-draft.2",
      resources: ["workspaceMembers"],
      change: "`person_id` becomes `membership_id`.",
      reason:
        "app.workspace_members (0202) assigns an org membership, not a person, to the workspace (NOT NULL `membership_id`).",
      apply: editShape({
        remove: ["person_id"],
        add: {
          membership_id: {
            schema: fields.ref("membership assigned to the workspace, in the same org"),
            create: "required",
            update: false,
          },
        },
      }),
    },
    {
      id: "team-member-membership",
      since: "1.0.0-draft.2",
      resources: ["teamMembers"],
      change: "`person_id` becomes `membership_id`.",
      reason:
        "app.team_members (0202) assigns an org membership, not a person, to the team (NOT NULL `membership_id`).",
      apply: editShape({
        remove: ["person_id"],
        add: {
          membership_id: {
            schema: fields.ref("member of the team, in the same org"),
            create: "required",
            update: false,
          },
        },
      }),
    },
    {
      id: "org-brand-columns",
      since: "1.0.0-draft.2",
      resources: ["orgBrandings"],
      change:
        "The resource reads `app.org_brands`: logos, favicon and app icon are storage paths, the accent and neutral tint are hex colors, and adds `font_family`, `radius_scale`, `email_sender_name`, `support_email`, `legal_entity_name` and `suppress_powered_by`; removes `logo_document_id`, `accent_token` and `gateway_domain`; `display_name` becomes nullable.",
      reason:
        "White label is app.org_brands (0850): object paths in the org-brand bucket, `accent_hex` and `neutral_tint_hex` colors, typography and radius choices and sender details; the Gateway domain is an app.org_domains row, and `display_name` is NULL until set.",
      apply: all(
        setTable("app.org_brands"),
        editShape({
          nullable: ["display_name"],
          remove: ["logo_document_id", "accent_token", "gateway_domain"],
          add: {
            logo_light_path: brandPath(
              "Logo for light themes: object path in the org-brand bucket, starting with the org id.",
            ),
            logo_dark_path: brandPath("Logo for dark themes: object path in the org-brand bucket."),
            favicon_path: brandPath("Favicon: object path in the org-brand bucket."),
            app_icon_path: brandPath("App icon: object path in the org-brand bucket."),
            accent_hex: optional(
              hex(
                "Accent color as uppercase #RRGGBB, replacing accent-default in every theme; null keeps the platform accent.",
              ),
            ),
            neutral_tint_hex: optional(hex("Optional neutral tint as uppercase #RRGGBB.")),
            font_family: optional(
              orNull(
                fields.text(
                  "Font family from the approved list; null keeps the platform font.",
                  "Inter",
                ),
              ),
            ),
            radius_scale: optional(
              label(["Compact", "Default", "Rounded"], "Corner radius scale."),
            ),
            email_sender_name: optional(
              orNull(fields.text("Sender name on emails sent for the org.", "Northwind Live")),
            ),
            support_email: optional(
              orNull(fields.email("Support address shown on branded surfaces.")),
            ),
            legal_entity_name: optional(
              orNull(
                fields.text(
                  "Legal entity named on generated documents and emails.",
                  "Northwind Live LLC",
                ),
              ),
            ),
            suppress_powered_by: optional(
              fields.bool(
                "True hides Powered by XOS; it takes effect only while the plan includes white label.",
                false,
              ),
            ),
          },
        }),
      ),
    },
    {
      id: "role-code-and-band",
      since: "1.0.0-draft.2",
      resources: ["roles"],
      change:
        "Adds `code` and `band` (required on create); removes `base_role`; `org_id` and `name` become nullable for system roles.",
      reason:
        "app.roles (0202) holds system roles (NULL `org_id`, labels from i18n by `code`, so NULL `name`) and custom roles, each with a NOT NULL `code` and a Section 8 `band`; there is no base role column.",
      apply: editShape({
        nullable: ["org_id", "name"],
        remove: ["base_role"],
        add: {
          code: {
            schema: fields.code(
              "Role code. System role labels come from the i18n catalogs keyed by it; custom role codes never reuse a system code.",
              "site_lead",
            ),
            create: "required",
            update: false,
          },
          band: {
            schema: fields.int(
              "Band in Section 8 order, 1 Owner to 7 Viewer. Custom roles take 2 to 7, and a person assigns only roles at or below their own band.",
              4,
              1,
            ),
            create: "required",
          },
        },
      }),
    },
    {
      id: "role-capability-code-and-reach",
      since: "1.0.0-draft.2",
      resources: ["roleCapabilities"],
      change:
        "`capability` becomes `capability_code`; adds `reach` (required on create); `org_id` becomes nullable for system roles.",
      reason:
        "app.role_capabilities (0202) names the column `capability_code`, grants each capability with a NOT NULL `reach` (own, assigned or organization), and leaves `org_id` NULL for system role grants.",
      apply: editShape({
        nullable: ["org_id"],
        rename: { capability: "capability_code" },
        add: {
          reach: {
            schema: label(
              ["own", "assigned", "organization"],
              "Own rows, assigned scopes or the whole org.",
            ),
            create: "required",
          },
        },
      }),
    },
    {
      id: "user-capability-grant-membership",
      since: "1.0.0-draft.2",
      resources: ["userCapabilityGrants"],
      change:
        "`person_id` becomes `membership_id` and `capability` becomes `capability_code`; adds `scope_kind`, `scope_id`, `reason` (required on create) and the server-set `granted_by`; `valid_from` becomes optional on create.",
      reason:
        "app.user_capability_grants (0202) grants a capability to an org membership, optionally limited to a scope, with a NOT NULL reason, the granting person and `valid_from` defaulting to now.",
      apply: editShape({
        rename: { capability: "capability_code" },
        remove: ["person_id"],
        optionalOnCreate: ["valid_from"],
        add: {
          membership_id: {
            schema: fields.ref("membership that receives the capability"),
            create: "required",
            update: false,
          },
          scope_kind: optional(
            orNull(
              label(
                [...SCOPE_KINDS],
                "Kind of scope the grant is limited to; null for an org-wide grant.",
              ),
            ),
          ),
          scope_id: optional(
            orNull(
              fields.ref(
                "workspace, team, project or record the grant is limited to; null for an org-wide grant",
              ),
            ),
          ),
          granted_by: { schema: orNull(fields.ref("person who granted it; never the grantee")) },
          reason: {
            schema: fields.text(
              "Why the grant was made.",
              "Covering approvals during the tour.",
              2000,
            ),
            create: "required",
          },
        },
      }),
    },
    {
      id: "record-grant-target-and-grantee",
      since: "1.0.0-draft.2",
      resources: ["recordGrants"],
      change:
        "`grantee_urn` becomes `grantee_person_id` or `grantee_org_id` and `subject_urn` becomes `target_kind` with `target_id`; `capability` becomes `capability_code`; adds `valid_from`, `reason` (required on create) and the server-set `granted_by`; `valid_to` becomes required on create.",
      reason:
        "app.record_grants (0202) grants a capability on one target row to a person or an organization, with a NOT NULL end (`valid_to` has no default), a reason and the granting person; it stores ids, not URNs.",
      apply: editShape({
        rename: { capability: "capability_code" },
        remove: ["grantee_urn", "subject_urn"],
        requireOnCreate: ["valid_to"],
        add: {
          target_kind: {
            schema: label([...SCOPE_KINDS], "Kind of target."),
            create: "required",
            update: false,
          },
          target_id: { schema: fields.ref("target row"), create: "required", update: false },
          grantee_person_id: optional(
            orNull(fields.ref("person who receives access; null when an organization does")),
          ),
          grantee_org_id: optional(
            orNull(
              fields.ref(
                "organization whose active members receive access; null when a person does",
              ),
            ),
          ),
          valid_from: optional(fields.instant("When access starts.")),
          granted_by: { schema: orNull(fields.ref("person who granted it; never the grantee")) },
          reason: {
            schema: fields.text(
              "Why the grant was made, for example the partner agreement clause.",
              "Partner agreement, clause 4.2.",
              2000,
            ),
            create: "required",
          },
        },
      }),
    },
    {
      id: "delegation-memberships",
      since: "1.0.0-draft.2",
      resources: ["delegations"],
      change:
        "`from_person_id` and `to_person_id` become `delegator_membership_id` and `delegate_membership_id`; adds `capability_code` and `reason` (required on create).",
      reason:
        "app.delegations (0202) delegates between org memberships, optionally for one capability (NULL delegates every approve-class capability), with a NOT NULL reason.",
      apply: editShape({
        remove: ["from_person_id", "to_person_id"],
        add: {
          delegator_membership_id: {
            schema: fields.ref("member who delegates"),
            create: "required",
            update: false,
          },
          delegate_membership_id: {
            schema: fields.ref("member who acts for the delegator; never the delegator"),
            create: "required",
            update: false,
          },
          capability_code: optional(
            orNull(
              capabilityCode(
                "Delegated capability; null delegates every approve-class capability the delegator holds.",
              ),
            ),
          ),
          reason: {
            schema: fields.text("Why the delegation exists.", "Annual leave, 12 to 26 May.", 2000),
            create: "required",
          },
        },
      }),
    },
    {
      id: "spend-authority-scope",
      since: "1.0.0-draft.2",
      resources: ["spendAuthorityLimits"],
      change:
        "The resource reads `app.spend_authorities`: `person_id` becomes `membership_id`, `currency` becomes `currency_code`, and adds `account_code`, `cost_center_id`, `valid_from` and `valid_to`; `document_type` gains Requisition; `role_id` becomes nullable and `limit_minor` required on create.",
      reason:
        "Spend authority is app.spend_authorities (0320): a limit for a role or one membership, optionally scoped to a GL account and cost center, valid between two times, with a NOT NULL `limit_minor`; app.spend_document_type (0360) includes Requisition.",
      apply: all(
        setTable("app.spend_authorities"),
        editShape({
          nullable: ["role_id"],
          rename: { currency: "currency_code" },
          remove: ["person_id"],
          requireOnCreate: ["limit_minor"],
          add: {
            document_type: {
              schema: label(
                [
                  "Purchase Order",
                  "Change Order",
                  "Expense",
                  "Invoice Approval",
                  "Contract",
                  "Payroll Run",
                  "Requisition",
                ],
                "Document type the limit applies to.",
              ),
              create: "required",
            },
            membership_id: optional(
              orNull(
                fields.ref(
                  "membership of the one person the limit applies to; null when it applies to a role",
                ),
              ),
            ),
            account_code: optional(
              orNull(
                fields.code("GL account the limit is scoped to; null for every account.", "5100"),
              ),
            ),
            cost_center_id: optional(
              orNull(fields.ref("cost center the limit is scoped to; null for every cost center")),
            ),
            valid_from: optional(fields.instant("When the limit starts.")),
            valid_to: optional(
              orNull(fields.instant("When the limit ends; null while open-ended.")),
            ),
          },
        }),
      ),
    },
    {
      id: "separation-of-duties-platform-rules",
      since: "1.0.0-draft.2",
      resources: ["separationOfDutiesRules"],
      change:
        "The rules are a read-only list of platform rules with `code`, `enforced_on` and `description`: removes `get`, `create`, `update` and `delete`, the tenant base fields, `rule` and `is_default`.",
      reason:
        "app.separation_of_duties_rules (0320) is a view of the platform's rules, enforced in the approval RPCs; organizations cannot add, change or remove them, and the rows have no id or audit columns.",
      apply: all(
        removeVerbs("get", "create", "update", "delete"),
        editShape({
          key: "code",
          rename: { rule: "code" },
          remove: [
            "id",
            "org_id",
            "created_at",
            "created_by",
            "updated_at",
            "updated_by",
            "is_default",
          ],
          add: {
            code: {
              schema: fields.code("Rule code, the rule a refusal names.", "sod_approval_requester"),
            },
            description: {
              schema: fields.text(
                "What the rule forbids.",
                "The requester of a spend document cannot approve it.",
                2000,
              ),
            },
          },
        }),
      ),
    },
    {
      id: "column-classification-read-capability",
      since: "1.0.0-draft.2",
      resources: ["columnClassifications"],
      change: "`reveal_capability` becomes `read_capability`.",
      reason:
        "app.column_classifications (0330) names the capability that unmasks a Restricted column `read_capability`.",
      apply: editShape({ rename: { reveal_capability: "read_capability" } }),
    },
    {
      id: "capability-registry-columns",
      since: "1.0.0-draft.2",
      resources: ["capabilities"],
      // The frozen `classification` field was the first, nullable reference to Classification, so
      // the shared component read as nullable. Without it Classification is the plain enum again.
      components: ["schemas/Classification"],
      change:
        "`capability` becomes `code` and `group` becomes `module_code`; `classification` gives way to `capability_class`; adds `description` and `sort_order`.",
      reason:
        "The capability registry app.capabilities (0201, 0203) stores each code with its module, the kind of act it authorizes (read, write, approve, manage, export), a description and its registry order; column classification is a separate list (app.column_classifications), and the shared Classification component, first referenced by the removed field, is the plain enum again.",
      apply: editShape({
        rename: { capability: "code", group: "module_code" },
        remove: ["classification"],
        add: {
          capability_class: {
            schema: label(
              ["read", "write", "approve", "manage", "export"],
              "Kind of act the capability authorizes.",
            ),
          },
          description: {
            schema: fields.text(
              "What the capability allows, for documentation and the roles page.",
              "Approve purchase orders within spend authority.",
              2000,
            ),
          },
          sort_order: { schema: fields.int("Registry order, the default sort.", 1) },
        },
      }),
    },
    {
      id: "api-key-revoked-by",
      since: "1.0.0-draft.2",
      resources: ["apiKeys"],
      change: "Adds the server-set `revoked_by`.",
      reason: "app.api_keys (0921) records the person who revoked a key in `revoked_by`.",
      apply: editShape({
        add: { revoked_by: { schema: orNull(fields.ref("person who revoked the key")) } },
      }),
    },
    {
      id: "service-account-identity",
      since: "1.0.0-draft.2",
      resources: ["serviceAccounts"],
      change: "Adds the server-set `user_id`, `person_id` and `membership_id`.",
      reason:
        "app.service_accounts (0922) links each service account to the sign-in, person and membership the platform creates for it; the caller never supplies them.",
      apply: editShape({
        add: {
          user_id: {
            schema: fields.ref(
              "sign-in of the service account, which never signs in interactively",
            ),
          },
          person_id: {
            schema: fields.ref("person row of the service account, the actor in audit columns"),
          },
          membership_id: {
            schema: fields.ref("membership that carries the service account's role in the org"),
          },
        },
      }),
    },
    {
      id: "webhook-endpoint-disable",
      since: "1.0.0-draft.2",
      resources: ["webhookEndpoints"],
      change:
        "`enabled` gives way to the nullable `disabled_at`; adds `description`. `events` stays, read from app.webhook_endpoint_events.",
      reason:
        "app.webhook_endpoints (0510) records when an endpoint was turned off (`disabled_at`; disabled endpoints get no new deliveries) and a description; subscribed event types are rows of app.webhook_endpoint_events.",
      apply: editShape({
        remove: ["enabled"],
        add: {
          description: optional(
            orNull(fields.text("What the endpoint is for.", "Sync approved POs to the ERP.", 2000)),
          ),
          disabled_at: {
            schema: orNull(
              fields.instant(
                "When the endpoint was turned off; disabled endpoints get no new deliveries.",
              ),
            ),
            update: true,
          },
        },
      }),
    },
    {
      id: "webhook-delivery-attempts",
      since: "1.0.0-draft.2",
      resources: ["webhookDeliveries"],
      change:
        "A delivery names its `domain_event_id` and carries `attempt_count`, `next_attempt_at`, `last_attempt_at`, `last_response_status`, `last_error` and `replay_requested_by`; removes `event`, `attempt` and `response_status`.",
      reason:
        "app.webhook_deliveries (0510) is one row per event and endpoint whose attempts are counted on the row, with the latest response and error and who requested a replay.",
      apply: editShape({
        remove: ["event", "attempt", "response_status"],
        add: {
          domain_event_id: {
            schema: fields.ref(
              "domain event delivered; every attempt sends the same body built from it",
            ),
          },
          attempt_count: { schema: fields.int("Attempts started.", 1) },
          next_attempt_at: { schema: fields.instant("When the dispatcher may try next.") },
          last_attempt_at: { schema: orNull(fields.instant("When the latest attempt started.")) },
          last_response_status: {
            schema: orNull(
              fields.int(
                "HTTP status of the latest response; null when no response arrived.",
                200,
                100,
              ),
            ),
          },
          last_error: {
            schema: orNull(
              fields.text(
                "Network or HTTP error of the latest failed attempt.",
                "Connection timed out.",
                2000,
              ),
            ),
          },
          replay_requested_by: {
            schema: orNull(fields.ref("person who replayed the event from Atlas")),
          },
        },
      }),
    },
    {
      id: "webhook-event-catalog",
      since: "1.0.0-draft.2",
      resources: ["webhookEventTypes"],
      change:
        "The resource reads `app.domain_event_catalog`; `event` becomes `code` and adds `subject`.",
      reason:
        "Event types are the view app.domain_event_catalog (0301, 0510) over private.domain_event_types: a code, the table it describes and a description.",
      apply: all(
        setTable("app.domain_event_catalog"),
        editShape({
          rename: { event: "code" },
          add: {
            subject: {
              schema: fields.text("Table whose rows the event describes.", "purchase_orders"),
            },
          },
        }),
      ),
    },
    {
      id: "audit-event-columns",
      since: "1.0.0-draft.2",
      resources: ["auditEvents"],
      change:
        "The actor is `actor_kind` with `actor_person_id` and the subject `subject_table` with `subject_id`; adds `actor_ip`, `user_agent`, `request_id` and `redacted_at`; removes `actor_urn`, `subject_urn`, `capacity` and `occurred_at` (`created_at` is the time of the act).",
      reason:
        "app.audit_events (0501) stores the actor kind and person, the subject table and id, request evidence that redaction removes, and the redaction time; it has no URN or capacity columns.",
      apply: editShape({
        remove: ["actor_urn", "subject_urn", "capacity", "occurred_at"],
        add: {
          actor_kind: { schema: label(["Person", "Service", "System"], "Who acted.") },
          actor_person_id: { schema: orNull(fields.ref("person who acted, when a person acted")) },
          subject_table: { schema: fields.text("Table of the row acted on.", "purchase_orders") },
          subject_id: { schema: orNull(fields.ref("row acted on")) },
          actor_ip: {
            schema: orNull(
              fields.text(
                "Client IP address of the request. Removed at redaction.",
                "203.0.113.24",
              ),
            ),
          },
          user_agent: {
            schema: orNull(
              fields.text(
                "Client user agent of the request. Removed at redaction.",
                "Mozilla/5.0",
                2000,
              ),
            ),
          },
          request_id: {
            schema: orNull(fields.text("API request id, for correlating with logs.", "req_01J9Z6")),
          },
          redacted_at: {
            schema: orNull(fields.instant("When personal data in the event was redacted.")),
          },
        },
      }),
    },
    {
      id: "consent-record-columns",
      since: "1.0.0-draft.2",
      resources: ["consentRecords"],
      change:
        "`purpose` becomes `purpose_code`; adds `notice_version` and `source` (required on create) and the server-set `captured_at`, `captured_ip` and `withdrawn_at`; removes `granted` and `recorded_at`.",
      reason:
        "app.consent_records (0501) records each consent with the notice version and source, stamps capture time and IP, and records withdrawal as `withdrawn_at`; a row is a grant, so there is no granted flag.",
      apply: editShape({
        rename: { purpose: "purpose_code" },
        remove: ["granted", "recorded_at"],
        add: {
          notice_version: {
            schema: fields.text(
              "Version of the notice shown when consent was given.",
              "2026-10-01",
            ),
            create: "required",
          },
          source: {
            schema: label(
              ["Web", "Mobile", "Email", "SMS", "Import", "Support"],
              "Where consent was captured.",
            ),
            create: "required",
          },
          captured_at: { schema: fields.instant("When consent was given, set by the database.") },
          captured_ip: {
            schema: orNull(
              fields.text("Client IP address at capture, set by the database.", "203.0.113.24"),
            ),
          },
          withdrawn_at: {
            schema: orNull(
              fields.instant("When the person withdrew consent; null while it stands."),
            ),
          },
        },
      }),
    },
    {
      id: "dsar-request-columns",
      since: "1.0.0-draft.2",
      resources: ["dsarRequests"],
      change:
        "`person_id` becomes the nullable `subject_person_id`; adds `subject_email` (required on create), `details` and the server-set `received_at`; `request_type` is the database enum; removes `completed_at`.",
      reason:
        "app.dsar_requests (0501) identifies the subject by email (an account is optional), starts the clock at `received_at`, takes `request_type` from app.dsar_request_type (which includes Opt Out of Sale, rejected by the Title Case pattern) and records completion as a state transition.",
      apply: editShape({
        remove: ["person_id", "completed_at"],
        add: {
          subject_person_id: optional(
            orNull(fields.ref("person the request is about, when they have an account")),
          ),
          subject_email: {
            schema: fields.email("Email the requester gave, used to verify identity and to reply."),
            create: "required",
          },
          request_type: {
            schema: label(
              [
                "Access",
                "Rectification",
                "Erasure",
                "Restriction",
                "Portability",
                "Objection",
                "Opt Out of Sale",
              ],
              "What the requester exercises.",
            ),
            create: "required",
          },
          details: optional(
            orNull(
              fields.text(
                "What the requester asked for, in their words.",
                "Send me my timesheets.",
                4000,
              ),
            ),
          ),
          received_at: {
            schema: fields.instant("When the request was received; the clock starts here."),
          },
        },
      }),
    },
    {
      id: "retention-policy-columns",
      since: "1.0.0-draft.2",
      resources: ["retentionPolicies"],
      change:
        "`retention_days` gives way to `retention` (an interval), and adds `basis`, `time_column`, `purge_method`, `redact_personal_data_after` and `rationale`.",
      reason:
        "app.retention_policies (0500) states each period as an interval with what starts the clock, how expired rows leave, when personal data is redacted and why.",
      apply: editShape({
        remove: ["retention_days"],
        add: {
          basis: {
            schema: orNull(label(["Soft Deleted", "Age"], "What starts the retention clock.")),
          },
          time_column: {
            schema: orNull(fields.text("Column that starts the clock.", "deleted_at")),
          },
          retention: {
            schema: orNull(fields.text("How long rows are kept, as an interval.", "7 years")),
          },
          purge_method: {
            schema: orNull(
              label(["Delete", "Drop Partition", "Account Lifecycle"], "How expired rows leave."),
            ),
          },
          redact_personal_data_after: {
            schema: orNull(
              fields.text("When personal data in the table is redacted, if ever.", "90 days"),
            ),
          },
          rationale: {
            schema: orNull(
              fields.text("Why the period was chosen.", "Tax records are kept seven years.", 2000),
            ),
          },
        },
      }),
    },
    {
      id: "setting-locks-table",
      since: "1.0.0-draft.2",
      resources: ["settingLocks"],
      change: "The resource reads `app.setting_values`.",
      reason:
        "A lock is the `locked` flag of an Organization value in app.setting_values (0850); there is no app.setting_locks table. The A30 handlers already read it.",
      apply: setTable("app.setting_values"),
    },
    {
      id: "api-key-create-returns-secret",
      since: "1.0.0-draft.2",
      resources: ["apiKeys"],
      change:
        "`apiKeys.create` answers 201 with ApiKeySecret (`api_key_id` and the full `secret`, shown once) instead of the ApiKey read shape.",
      reason:
        "app.create_api_key (0921) stores only the key's hash and returns the secret once; answering with the read shape would lose the only copy of the secret.",
      apply: createAnswering(
        pf.ApiKeySecret,
        "app.create_api_key",
        "Create an API key",
        "Creates an API key with scopes and an expiry, optionally for a service account, through `app.create_api_key`. The full secret is returned once; only its hash is stored.",
      ),
    },
    {
      id: "webhook-endpoint-create-returns-secret",
      since: "1.0.0-draft.2",
      resources: ["webhookEndpoints"],
      components: ["schemas/WebhookEndpointSecret"],
      change:
        "`webhookEndpoints.create` answers 201 with WebhookEndpointSecret (`webhook_endpoint_id` and the `signing_secret`, shown once) instead of the WebhookEndpoint read shape.",
      reason:
        "app.create_webhook_endpoint (0510) stores the signing secret in Vault and returns it once; it is never readable afterwards, so the read shape would lose it.",
      apply: createAnswering(
        WebhookEndpointSecret,
        "app.create_webhook_endpoint",
        "Create a webhook endpoint",
        "Creates an endpoint subscribed to the given event types through `app.create_webhook_endpoint`. The signing secret is returned once.",
      ),
    },
    {
      id: "service-account-role",
      since: "1.0.0-draft.2",
      resources: ["serviceAccounts"],
      change:
        "ServiceAccountCreate takes the write-only `role_id` (required) and no longer takes `owner_person_id`, which the server sets to the creator; the owner can still change on update.",
      reason:
        "app.create_service_account (0922) creates the account's membership with one role, so it requires p_role_id, and records the creator as the owner.",
      apply: editShape({
        add: {
          role_id: {
            schema: fields.ref("role the service account's membership holds"),
            create: "required",
            update: false,
            read: false,
          },
          owner_person_id: { schema: fields.ref("owner"), update: true },
        },
      }),
    },
    ...integrationCorrections,

    // A50 (gate 5, RRR-94, ADR 0032) ----------------------------------------------------------------
    {
      id: "subscription-plan-through-billing",
      since: "1.0.0-draft.2",
      resources: ["subscriptions"],
      change:
        "Removes `subscriptions.update`: the plan changes through billing checkout, which the billing service applies.",
      reason:
        "A plan is paid for: app.sync_subscription_from_stripe (0560), granted to the service role only, is the one path from a Stripe subscription to app.subscriptions, and it sets the plan the server resolved from the paid price. Writing `plan_code` directly would grant a plan nobody paid for. Decided in ADR 0032.",
      apply: removeVerbs("update"),
    },
    {
      id: "org-export-log",
      since: "1.0.0-draft.2",
      resources: ["orgExports"],
      change:
        "An org export is the log of a full export the Owner built: `table_count`, `row_count`, `file_count` and `manifest_sha256` (all required on create) replace `format`, `export_state` and `document_id`. Creating needs org.organization.delete.",
      reason:
        "app.org_exports (1063) is append-only and logs each full export (Section 14.7) with its counts and the SHA-256 of its manifest; the archive is built with the Owner's own row level security from app.org_export_tables and recorded through app.record_org_export. There is no export job, state or stored document. Decided in ADR 0032.",
      apply: all(
        editShape({
          remove: ["format", "export_state", "document_id"],
          add: {
            table_count: {
              schema: fields.int("Tables in the archive.", 412),
              create: "required",
              update: false,
            },
            row_count: {
              schema: z.int().min(0).meta({
                description: "Rows across every table.",
                example: 182340,
                format: "int64",
              }),
              create: "required",
              update: false,
            },
            file_count: {
              schema: fields.int("Stored files included.", 96),
              create: "required",
              update: false,
            },
            manifest_sha256: {
              schema: z
                .string()
                .regex(/^[0-9a-f]{64}$/)
                .meta({
                  description: "SHA-256 of the archive's manifest.json, lowercase hex.",
                  example: "9f2c4e1a7b3d5f6e8a0c2e4f6a8b0d2c4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b",
                }),
              create: "required",
              update: false,
            },
          },
        }),
        setCapabilities({ read: "org.organization.delete", create: "org.organization.delete" }),
      ),
    },
    {
      id: "settings-features-not-built",
      since: "1.0.0-draft.2",
      resources: [
        "orgLegalEntities",
        "orgIpAllowlistEntries",
        "accessReviewCampaigns",
        "accessReviewItems",
        "breakGlassSessions",
        "projectShares",
      ],
      change:
        "Removes every operation of orgLegalEntities, orgIpAllowlistEntries, accessReviewCampaigns, accessReviewItems, breakGlassSessions and projectShares.",
      reason:
        "None of these has a table or a behavior behind it: app.org_legal_entities, app.org_ip_allowlist, app.access_review_campaigns, app.access_review_items, app.break_glass_sessions and app.project_shares were never built, and only setting definitions exist (org.fiscal_year_start_month, org.base_currency, security.ip_allowlist, access_reviews.*, 0851). Sections 4.5 and 8.4 give them enforcement (the allow-list refusing other addresses, break-glass needing MFA, a one-hour limit and an Admin notice, reviews removing unreviewed access, shares opening a project to a partner). A table without that enforcement would report protection that does not exist, so the operations leave v1 until each feature is built and return additively then. Decided in ADR 0032.",
      apply: (spec) =>
        removeVerbs(...spec.verbs)({
          ...spec,
          actions: [],
        }),
    },
  ],
});
