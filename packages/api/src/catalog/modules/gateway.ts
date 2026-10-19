/**
 * Gateway operations beyond the frozen v1 catalog (additive only, Section 10.1). Declare new
 * resources and new actions on Gateway resources here. See "Adding operations" in
 * packages/api/README.md. Corrections to frozen Gateway resources follow ADR 0023.
 */
import { z } from "@hono/zod-openapi";
import {
  ExternalRoleType,
  OpportunityState,
  OpportunityVisibility,
  RateType,
  canonCodes,
  fields,
} from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, removeVerbs, setTable } from "../correct.ts";

const label = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

const optional = (schema: z.ZodType) => ({ schema, create: "optional" as const });

export const additions = defineAdditions("Gateway", {
  corrections: [
    {
      id: "marketplace-listing-view",
      since: "1.0.0-draft.2",
      resources: ["marketplace"],
      change:
        "The listing reads `api_external.opportunities`: `opportunity_id` becomes `id`, `organization_id` becomes `org_id`, `locality` becomes `venue_locality`, the first call becomes the dates `starts_on` and `ends_on`, and the posted pay is `pay_min_minor`, `pay_max_minor` and `currency_code` (nullable) with `rate_on_request`. Adds `org_name`, `org_verified`, `description`, `cat_urid`, `venue_name`, `jurisdiction_id`, `visibility`, `deadline_at`, `minimum_age`, `opportunity_state` and `position_count`.",
      reason:
        "There is no v_marketplace_opportunities view; A28 serves the marketplace from the view api_external.opportunities (0750, 0763), whose columns are these. Opportunities without posted pay show Rate on Request, so the currency is null with the pay.",
      apply: all(
        setTable("api_external.opportunities"),
        editShape({
          rename: {
            opportunity_id: "id",
            organization_id: "org_id",
            locality: "venue_locality",
            rate_min_minor: "pay_min_minor",
            rate_max_minor: "pay_max_minor",
          },
          remove: ["starts_at", "currency"],
          add: {
            org_name: { schema: fields.text("Posting organization name.", "Northwind Live") },
            org_verified: {
              schema: fields.bool("True when the posting organization is verified.", true),
            },
            description: {
              schema: orNull(
                fields.longText(
                  "Description of the work.",
                  "Load-in and show calls for six weekends.",
                ),
              ),
            },
            cat_urid: { schema: orNull(canonCodes.UridAtAnyGrain) },
            venue_name: { schema: orNull(fields.text("Venue name.", "Harbor Lawn")) },
            jurisdiction_id: { schema: orNull(canonCodes.JurisdictionId) },
            starts_on: { schema: orNull(fields.date("First day of the work.")) },
            ends_on: { schema: orNull(fields.date("Last day of the work.")) },
            visibility: { schema: OpportunityVisibility },
            rate_type: { schema: orNull(RateType) },
            currency_code: {
              schema: orNull(
                fields.currency("ISO 4217 currency of the posted pay; null when unposted."),
              ),
            },
            rate_on_request: {
              schema: fields.bool(
                "True when no pay is posted: the listing shows Rate on Request.",
                false,
              ),
            },
            deadline_at: { schema: orNull(fields.instant("Deadline for applications and bids.")) },
            minimum_age: { schema: orNull(fields.int("Minimum age for the work.", 18, 16)) },
            opportunity_state: { schema: OpportunityState },
            position_count: { schema: fields.int("Number of open positions.", 4) },
          },
        }),
      ),
    },
    {
      id: "saved-search-filter-columns",
      since: "1.0.0-draft.2",
      resources: ["savedSearches"],
      change:
        "Replaces the free-form `query` with the filter columns: `role_type`, `role_code`, `cat_urid`, `jurisdiction_id`, `starts_after`, `ends_before`, `min_rate_minor` and `currency_code`.",
      reason:
        "app.saved_searches (0720) stores each marketplace filter as its own nullable column, so alerts can match listings in the database; it has no query text.",
      apply: editShape({
        remove: ["query"],
        optionalOnCreate: ["alerts_enabled"],
        add: {
          role_type: optional(orNull(ExternalRoleType)),
          role_code: optional(orNull(canonCodes.RoleCode)),
          cat_urid: optional(orNull(canonCodes.UridAtAnyGrain)),
          jurisdiction_id: optional(orNull(canonCodes.JurisdictionId)),
          starts_after: optional(orNull(fields.date("Earliest start date."))),
          ends_before: optional(orNull(fields.date("Latest end date."))),
          min_rate_minor: optional(fields.money("Minimum posted pay.", 3500)),
          currency_code: optional(orNull(fields.currency("ISO 4217 currency of the minimum pay."))),
        },
      }),
    },
    {
      id: "opportunity-alert-times",
      since: "1.0.0-draft.2",
      resources: ["opportunityAlerts"],
      change: "Adds `matched_at`; `sent_at` becomes the nullable `delivered_at`.",
      reason:
        "app.opportunity_alerts (0720) records when the match was found (`matched_at`) and, separately, when the alert was delivered (`delivered_at`, NULL until then).",
      apply: editShape({
        rename: { sent_at: "delivered_at" },
        nullable: ["delivered_at"],
        add: {
          matched_at: { schema: fields.instant("When the match was found.") },
        },
      }),
    },
    {
      id: "listing-report-columns",
      since: "1.0.0-draft.2",
      resources: ["listingReports"],
      change:
        "A report names the `opportunity_id` (required on create) and carries `details`, the server-set `reporter_person_id` and `reported_at`; `reason` is the database enum. Removes `subject_urn` and `report_state`.",
      reason:
        "app.listing_reports (0720) reports an opportunity (NOT NULL `opportunity_id`), stamps the reporter from the session and the time from the database, takes `reason` from app.listing_report_reason and has no state column: decisions are app.moderation_actions rows.",
      apply: editShape({
        remove: ["subject_urn", "report_state"],
        add: {
          opportunity_id: { schema: fields.ref("reported opportunity"), create: "required" },
          reporter_person_id: {
            schema: fields.ref("person who reported, set from the session"),
          },
          reason: {
            schema: label(
              [
                "Illegal Content",
                "Discrimination",
                "Fraud",
                "Misleading Information",
                "Missing Pay Range",
                "Safety",
              ],
              "Ground for the report.",
            ),
            create: "required",
          },
          details: optional(
            orNull(
              fields.longText("What the reporter saw.", "The listing asks for an upfront fee."),
            ),
          ),
          reported_at: {
            schema: fields.instant("When the report was made, set by the database."),
          },
        },
      }),
    },
    {
      id: "moderation-action-columns",
      since: "1.0.0-draft.2",
      resources: ["moderationActions"],
      change:
        "A decision names the `opportunity_id` (required on create) and the server-set `decided_at`; `listing_report_id` becomes nullable and `action` is the database enum.",
      reason:
        "app.moderation_actions (0720) decides on an opportunity (NOT NULL `opportunity_id`), may be taken without a report (nullable `listing_report_id`), takes `action` from app.moderation_action_kind and stamps `decided_at`.",
      apply: editShape({
        nullable: ["listing_report_id"],
        add: {
          opportunity_id: { schema: fields.ref("opportunity decided on"), create: "required" },
          action: {
            schema: label(["Removed", "Restricted", "Restored", "No Action"], "Decision taken."),
            create: "required",
          },
          decided_at: { schema: fields.instant("When the decision was made.") },
        },
      }),
    },
    {
      id: "moderation-action-platform-decision",
      since: "1.0.0-draft.2",
      resources: ["moderationActions"],
      change:
        "Removes `moderationActions.create`: the public API lists and reads moderation decisions, and the platform operator console records them.",
      reason:
        "app.moderation_actions (0720) is append-only and written only by the platform: install_policies grants tenants a read policy and no insert policy, because a Digital Services Act decision is the platform's, never the listing organization's (Section 4.10, platform operator console). Decided in ADR 0031.",
      apply: removeVerbs("create"),
    },
    {
      id: "profile-share-snapshot",
      since: "1.0.0-draft.2",
      resources: ["profileShares"],
      change:
        "`organization_id` is the sharing external account (nullable; the receiving organization is `org_id`), `snapshot_at` becomes `shared_at`, `live_updates` gives way to `engagement_id`, and `shared_fields` lists each shared field with its value. `person_id` is set from the session.",
      reason:
        "app.profile_shares (0710) stores the receiving org as `org_id`, the sharer as `person_id` or `organization_id` (exactly one), the engagement whose openness decides live updates, and `shared_at`; app.share_profile writes the chosen fields with their values to app.profile_share_fields.",
      apply: editShape({
        rename: { snapshot_at: "shared_at" },
        remove: ["live_updates"],
        serverSet: ["person_id"],
        add: {
          organization_id: optional(
            orNull(
              fields.ref(
                "external account sharing its company profile; null when a person shares their own",
              ),
            ),
          ),
          engagement_id: optional(
            orNull(
              fields.ref("engagement the share serves; live updates flow only while it is open"),
            ),
          ),
          shared_fields: {
            schema: z
              .array(
                z.object({
                  field_key: z
                    .string()
                    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/)
                    .meta({ description: "Profile field key.", example: "headline" }),
                  field_value: orNull(
                    fields.text("Value shared; null when shared empty.", "Head Rigger", 4000),
                  ),
                }),
              )
              .min(1)
              .meta({ description: "Each shared field with the value at the time of sharing." }),
            create: "required",
            update: false,
          },
        },
      }),
    },
    {
      id: "availability-calendar-visibility",
      since: "1.0.0-draft.2",
      resources: ["availabilityCalendars"],
      change: "Adds `visibility` (Private, Shared on Application or Public).",
      reason:
        "app.availability_calendars (0740) has a `visibility` column, defaulting to Private, that decides who reads the calendar.",
      apply: editShape({
        add: {
          visibility: optional(
            label(["Private", "Shared on Application", "Public"], "Who reads the calendar."),
          ),
        },
      }),
    },
    {
      id: "availability-block-kind",
      since: "1.0.0-draft.2",
      resources: ["availabilityBlocks"],
      change:
        "Replaces the boolean `available` with `availability_kind` (Available, Unavailable or Tentative) and adds `note`.",
      reason:
        "app.availability_blocks (0740) has a NOT NULL `availability_kind` with three values, which a boolean cannot carry, and a private note.",
      apply: editShape({
        remove: ["available"],
        add: {
          availability_kind: {
            schema: label(["Available", "Unavailable", "Tentative"], "Kind of block."),
            create: "required",
          },
          note: optional(
            orNull(fields.text("Private note of the owner.", "Holding for a tour.", 2000)),
          ),
        },
      }),
    },
    {
      id: "engagement-message-author",
      since: "1.0.0-draft.2",
      resources: ["engagementMessages"],
      change: "`sent_by` becomes `author_person_id`, nullable.",
      reason:
        "app.engagement_messages (0740) stamps `author_person_id` from the session and leaves it NULL for system messages.",
      apply: editShape({ rename: { sent_by: "author_person_id" }, nullable: ["author_person_id"] }),
    },
    {
      id: "tax-form-columns",
      since: "1.0.0-draft.2",
      resources: ["taxForms"],
      change:
        "A form belongs to the payee (`person_id` or `organization_id`), has a `form_kind` and a `signed_at`; `tax_identifier` is write-only and `tax_identifier_last4` becomes `tin_last4`. Removes `engagement_id` and `form_type`.",
      reason:
        "app.tax_forms (0730) is held per payee, not per engagement; app.submit_tax_form encrypts the identifier into `tin_encrypted`, which only the service role reads, and keeps `tin_last4` for display.",
      apply: editShape({
        remove: ["engagement_id", "form_type", "tax_identifier"],
        optionalOnCreate: ["foreign_performer_withholding"],
        rename: { tax_identifier_last4: "tin_last4" },
        add: {
          person_id: { schema: orNull(fields.ref("payee person, set from the session")) },
          organization_id: optional(orNull(fields.ref("payee external account"))),
          form_kind: {
            schema: label(["W-9", "W-8BEN", "W-8BEN-E"], "Tax form."),
            create: "required",
          },
          tax_identifier: {
            schema: z.string().min(4).max(64).meta({
              description: "Tax identifier. Write-only: it is encrypted and never returned.",
              example: "123456789",
            }),
            create: "required",
            read: false,
          },
          signed_at: {
            schema: fields.instant("When the payee signed the form, set by the database."),
          },
        },
      }),
    },
    {
      id: "payout-account-columns",
      since: "1.0.0-draft.2",
      resources: ["payoutAccounts"],
      change:
        "`provider_account_ref` becomes `provider_account_reference`, `account_last4` becomes nullable and `provider` is the database enum.",
      reason:
        "app.payout_accounts (0730) names the column `provider_account_reference`, stores `account_last4` only when the provider reports it, and takes `provider` from app.payout_provider (Stripe Connect or Accounting System).",
      apply: editShape({
        rename: { provider_account_ref: "provider_account_reference" },
        nullable: ["account_last4"],
        add: {
          provider: {
            schema: label(["Stripe Connect", "Accounting System"], "Payment provider."),
            create: "required",
            update: false,
          },
        },
      }),
    },
    {
      id: "background-check-result",
      since: "1.0.0-draft.2",
      resources: ["backgroundChecks"],
      change:
        "`provider_result` becomes the server-set enum `result`; `provider` becomes optional on create (Checkr).",
      reason:
        "app.background_checks (0730) stores the provider's verdict in a NOT NULL `result` from app.background_check_result, defaulting to Pending, and defaults `provider` to Checkr.",
      apply: editShape({
        remove: ["provider_result"],
        optionalOnCreate: ["provider"],
        add: {
          result: {
            schema: label(
              ["Pending", "Clear", "Consider", "Suspended", "Canceled"],
              "Result as the provider reports it.",
            ),
          },
        },
      }),
    },
  ],
});
