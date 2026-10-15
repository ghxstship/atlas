/**
 * Gateway handlers (A28 and A27 schema, A04P handlers): the external-party resources. Marketplace
 * search reads api_external.opportunities; saved searches, alerts, listing reports, moderation,
 * availability, threads, messages, payout accounts and background checks are tables read and
 * written as the caller. Profile shares and tax forms are written only through their secure RPCs
 * (app.share_profile, app.submit_tax_form), which take the receiving organization from the
 * credential; a tax identifier is write-only and only its last four digits are ever read. Row level
 * security and the column guards decide every refusal. See ADR 0023 for the corrected shapes.
 */
import { revokeProfileShare, shareProfile, submitTaxForm } from "@xos/data/gateway";
import type { Components } from "../contract/operations.generated.ts";
import { refused } from "../problem.ts";
import { requireOrg } from "../runtime/context.ts";
import type { HandlerSet } from "../runtime/handler.ts";
import { created, defineHandlers, ok } from "../runtime/handler.ts";
import {
  from,
  handlersFor,
  readFields,
  resourceSpec,
  run,
  tableResource,
  unwrap,
} from "./support/table.ts";
import type { Row } from "./support/table.ts";

// Marketplace -------------------------------------------------------------------------------------

/** The most listings one search returns; ranking is public: deadline, then start date. */
const SEARCH_LIMIT = 100;

/** Characters PostgREST treats as filter syntax inside `or()` values. */
function safeTerm(term: string): string {
  return term.replace(/[%,()*\\.:"]/g, " ").trim();
}

const LISTING_FIELDS = readFields(resourceSpec("marketplace")).filter((f) => f !== "distance_km");

// Profile shares ------------------------------------------------------------------------------------

const profileShares = tableResource("profileShares", {
  verbs: ["list", "get"],
  derived: ["shared_fields"],
  toContract: async (row, { db }) => ({
    ...row,
    shared_fields: await run<Row[]>(
      from(db, "profile_share_fields")
        .select("field_key, field_value")
        .eq("profile_share_id", row["id"])
        .is("deleted_at", null)
        .order("field_key", { ascending: true }),
    ),
  }),
});

// Tables --------------------------------------------------------------------------------------------

const taxForms = tableResource("taxForms", { verbs: ["list", "get"] });

const payoutAccounts = tableResource("payoutAccounts", {
  // A payee adds their own account unless they name the external account it belongs to.
  beforeCreate: (body, context) =>
    (body["person_id"] ?? null) === null && (body["organization_id"] ?? null) === null
      ? { person_id: context.personId }
      : {},
});

const parity = {
  "marketplace.search": async ({ query }, { db }) => {
    if (query.near !== undefined || query.radius_km !== undefined) {
      throw refused(
        "REFUSE",
        "Search by distance is not available yet: venues carry no coordinates. Search by keyword instead.",
        "marketplace.distance_unavailable",
      );
    }
    let request = from(db, "opportunities", "api_external")
      .select(LISTING_FIELDS.join(","))
      .eq("opportunity_state", "Published");
    const term = query.q === undefined ? "" : safeTerm(query.q);
    if (term.length > 0) request = request.or(`title.ilike.*${term}*,description.ilike.*${term}*`);
    const rows = await run<Row[]>(
      request
        .order("deadline_at", { ascending: true })
        .order("starts_on", { ascending: true })
        .order("id", { ascending: true })
        .limit(SEARCH_LIMIT),
    );
    return ok({
      data: rows.map((r) => ({ ...r, distance_km: null })),
      next_cursor: null,
    } as unknown as Components["MarketplaceListingPage"]);
  },

  ...handlersFor("Gateway", tableResource("savedSearches")),
  ...handlersFor("Gateway", tableResource("opportunityAlerts")),
  ...handlersFor("Gateway", tableResource("listingReports")),
  ...handlersFor("Gateway", tableResource("moderationActions", { verbs: ["list", "get"] })),
  ...handlersFor("Gateway", tableResource("availabilityCalendars")),
  ...handlersFor("Gateway", tableResource("availabilityBlocks")),
  ...handlersFor("Gateway", tableResource("engagementThreads")),
  ...handlersFor("Gateway", tableResource("engagementMessages", { orgColumn: false })),
  ...handlersFor("Gateway", payoutAccounts),
  ...handlersFor("Gateway", tableResource("backgroundChecks", { orgColumn: false })),

  ...handlersFor("Gateway", profileShares),
  "profileShares.create": async ({ body }, context) => {
    const share = unwrap(
      await shareProfile(context.db, {
        orgId: requireOrg(context).id,
        fields: body.shared_fields.map((f) => ({
          key: f.field_key,
          value: f.field_value as string,
        })),
        accountId: body.organization_id ?? null,
        engagementId: body.engagement_id ?? null,
      }),
    );
    return created((await profileShares.read(context, share.profileShareId)) as never);
  },
  "profileShares.revoke": async ({ params }, context) => {
    await profileShares.read(context, params.id, ["id"]);
    unwrap(await revokeProfileShare(context.db, params.id));
    return ok((await profileShares.read(context, params.id)) as never);
  },

  ...handlersFor("Gateway", taxForms),
  "taxForms.create": async ({ body }, context) => {
    const form = unwrap(
      await submitTaxForm(context.db, {
        orgId: requireOrg(context).id,
        formKind: body.form_kind,
        tin: body.tax_identifier,
        accountId: body.organization_id ?? null,
        foreignPerformerWithholding: body.foreign_performer_withholding ?? false,
      }),
    );
    return created((await taxForms.read(context, form.taxFormId)) as never);
  },
} satisfies HandlerSet<"Gateway">;

export const handlers = defineHandlers("Gateway", parity);
