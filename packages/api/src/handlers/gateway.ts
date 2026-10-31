/**
 * Gateway handlers (A28 and A27 schema, A04P handlers): the external-party resources. Marketplace
 * search reads api_external.opportunities; saved searches, alerts, listing reports, moderation,
 * availability, threads, messages, payout accounts and background checks are tables read and
 * written as the caller. Profile shares and tax forms are written only through their secure RPCs
 * (app.share_profile, app.submit_tax_form), which take the receiving organization from the
 * credential; a tax identifier is write-only and only its last four digits are ever read. Row level
 * security and the column guards decide every refusal. See ADR 0023 for the corrected shapes.
 * Distance search measures from `near` to the venue coordinates the view carries (A09 venue
 * location, A32 migration 1020); a listing whose venue is not located has no distance and is left
 * out of a radius search, never placed at a guessed position.
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
import { engagedAllocationHandlers } from "./parts/engaged-allocations.ts";

// Marketplace -------------------------------------------------------------------------------------

/** The most listings one search returns; ranking is public: deadline, then start date. */
const SEARCH_LIMIT = 100;

/** Characters PostgREST treats as filter syntax inside `or()` values. */
function safeTerm(term: string): string {
  return term.replace(/[%,()*\\.:"]/g, " ").trim();
}

const LISTING_FIELDS = readFields(resourceSpec("marketplace")).filter((f) => f !== "distance_km");

/** The most rows a radius search scans before the exact circle; the bounding box narrows first. */
const RADIUS_SCAN_LIMIT = 1000;

/** Mean Earth radius (IUGG), kilometers. */
const EARTH_RADIUS_KM = 6371.0088;

/** Kilometers per degree of latitude. */
const KM_PER_DEGREE = (Math.PI * EARTH_RADIUS_KM) / 180;

interface Point {
  readonly lat: number;
  readonly lon: number;
}

/** Parses `near` (latitude,longitude), refusing a point outside the WGS 84 ranges. */
function parseNear(near: string): Point {
  const [lat, lon] = near.split(",").map(Number) as [number, number];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw refused(
      "REFUSE",
      "The search location needs a latitude from -90 to 90 and a longitude from -180 to 180.",
      "marketplace.near_out_of_range",
    );
  }
  return { lat, lon };
}

/** Great-circle distance in kilometers (haversine), rounded to one decimal. */
function distanceKm(from: Point, to: Point): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(to.lat - from.lat);
  const dLon = rad(to.lon - from.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLon / 2) ** 2;
  const km = 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.round(km * 10) / 10;
}

/**
 * The latitude and longitude bounds that contain every point within the radius. Longitude bounds are
 * left open near a pole or across the antimeridian, where a box cannot hold the circle.
 */
function boundingBox(
  origin: Point,
  radiusKm: number,
): { minLat: number; maxLat: number; minLon?: number; maxLon?: number } {
  const dLat = radiusKm / KM_PER_DEGREE;
  const minLat = Math.max(-90, origin.lat - dLat);
  const maxLat = Math.min(90, origin.lat + dLat);
  const cos = Math.cos((Math.max(Math.abs(minLat), Math.abs(maxLat)) * Math.PI) / 180);
  if (maxLat >= 90 || minLat <= -90 || cos <= 0) return { minLat, maxLat };
  const dLon = radiusKm / (KM_PER_DEGREE * cos);
  if (origin.lon - dLon < -180 || origin.lon + dLon > 180) return { minLat, maxLat };
  return { minLat, maxLat, minLon: origin.lon - dLon, maxLon: origin.lon + dLon };
}

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
    if (query.radius_km !== undefined && query.near === undefined) {
      throw refused(
        "REFUSE",
        "A search radius needs a location to measure from; add near with a latitude and longitude.",
        "marketplace.radius_needs_near",
      );
    }
    const origin = query.near === undefined ? null : parseNear(query.near);
    const radius = query.radius_km ?? null;
    let request = from(db, "opportunities", "api_external")
      .select([...LISTING_FIELDS, "venue_latitude", "venue_longitude"].join(","))
      .eq("opportunity_state", "Published");
    const term = query.q === undefined ? "" : safeTerm(query.q);
    if (term.length > 0) request = request.or(`title.ilike.*${term}*,description.ilike.*${term}*`);
    if (origin !== null && radius !== null) {
      const box = boundingBox(origin, radius);
      // A range comparison is never true for NULL, so a venue that is not located drops out here.
      request = request.gte("venue_latitude", box.minLat).lte("venue_latitude", box.maxLat);
      if (box.minLon !== undefined && box.maxLon !== undefined) {
        request = request.gte("venue_longitude", box.minLon).lte("venue_longitude", box.maxLon);
      }
    }
    const rows = await run<Row[]>(
      request
        .order("deadline_at", { ascending: true })
        .order("starts_on", { ascending: true })
        .order("id", { ascending: true })
        .limit(radius === null ? SEARCH_LIMIT : RADIUS_SCAN_LIMIT),
    );
    const listed = rows.flatMap((row) => {
      const { venue_latitude: lat, venue_longitude: lon, ...listing } = row;
      const located = typeof lat === "number" && typeof lon === "number";
      const distance = origin !== null && located ? distanceKm(origin, { lat, lon }) : null;
      if (radius !== null && (distance === null || distance > radius)) return [];
      return [{ ...listing, distance_km: distance }];
    });
    return ok({
      data: listed.slice(0, SEARCH_LIMIT),
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

  // Allocations from the engaged party's side (R8): see ./parts/engaged-allocations.ts.
  ...engagedAllocationHandlers,
} satisfies HandlerSet<"Gateway">;

export const handlers = defineHandlers("Gateway", parity);
