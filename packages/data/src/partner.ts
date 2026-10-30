import type { XosClient } from "./client.ts";
import { fail, ok, type Result } from "./result.ts";
import {
  bool,
  num,
  numOrNull,
  rows,
  rpc,
  str,
  strOrNull,
  writtenId,
  type Raw,
} from "./platform-common.ts";
import { untyped } from "./untyped.ts";

/**
 * Partner console (A36, migration 1060; Section 4.6.1): client orgs, the default brand clients
 * inherit, client prices, wholesale statements and support sessions. Partner staff read billing facts
 * of their clients through app.partner_client_orgs; client records stay unreadable until the client's
 * Owner grants a support session. Every call runs as the caller, so row level security and the RPCs
 * decide.
 */

export type SubscriptionState = "trialing" | "active" | "past_due" | "read_only" | "canceled";
export type RadiusScale = "Compact" | "Default" | "Rounded";

export interface ClientOrg {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly planCode: string;
  readonly subscriptionState: SubscriptionState | null;
  readonly seats: number;
  readonly fieldMembers: number;
  readonly createdAt: string;
  readonly ownerJoined: boolean;
  readonly supportSessionId: string | null;
  readonly supportSessionEndsAt: string | null;
}

export async function listClientOrgs(
  db: XosClient,
  partnerOrgId: string,
): Promise<Result<ClientOrg[]>> {
  return rpc(db, "partner_client_orgs", { p_partner_org_id: partnerOrgId }, (data) =>
    ((data as Raw[] | null) ?? []).map((r) => ({
      id: str(r["org_id"]),
      name: str(r["name"]),
      slug: str(r["slug"]),
      planCode: str(r["plan_code"]),
      subscriptionState: strOrNull(r["subscription_state"]) as SubscriptionState | null,
      seats: num(r["seats"]),
      fieldMembers: num(r["field_members"]),
      createdAt: str(r["created_at"]),
      ownerJoined: bool(r["owner_joined"]),
      supportSessionId: strOrNull(r["support_session_id"]),
      supportSessionEndsAt: strOrNull(r["support_session_ends_at"]),
    })),
  );
}

export interface NewClientOrg {
  readonly partnerOrgId: string;
  readonly name: string;
  readonly slug: string;
  readonly ownerEmail: string;
  readonly planCode: string;
}

export interface CreatedClientOrg {
  readonly orgId: string;
  readonly inviteId: string;
  /** The Owner invitation token, returned once. */
  readonly inviteToken: string;
}

/** Creates a client org under the partner with an Owner invitation (org.partner.manage). */
export async function createClientOrg(
  db: XosClient,
  input: NewClientOrg,
): Promise<Result<CreatedClientOrg>> {
  const result = await rpc(
    db,
    "create_client_organization",
    {
      p_partner_org_id: input.partnerOrgId,
      p_name: input.name,
      p_slug: input.slug,
      p_owner_email: input.ownerEmail,
      p_plan_code: input.planCode,
    },
    (data) => (Array.isArray(data) ? (data[0] as Raw | undefined) : (data as Raw | null)) ?? null,
  );
  if (!result.ok) return result;
  if (!result.data) return fail({ kind: "not-found" });
  return ok({
    orgId: str(result.data["org_id"]),
    inviteId: str(result.data["invite_id"]),
    inviteToken: str(result.data["invite_token"]),
  });
}

// Default brand -----------------------------------------------------------------------------------------

export interface DefaultBrand {
  readonly id: string | null;
  readonly accentHex: string | null;
  readonly neutralTintHex: string | null;
  readonly fontFamily: string | null;
  readonly radiusScale: RadiusScale;
  readonly emailSenderName: string | null;
  readonly supportEmail: string | null;
  readonly allowClientOverride: boolean;
}

export const EMPTY_DEFAULT_BRAND: DefaultBrand = {
  id: null,
  accentHex: null,
  neutralTintHex: null,
  fontFamily: null,
  radiusScale: "Default",
  emailSenderName: null,
  supportEmail: null,
  allowClientOverride: true,
};

const BRAND_COLUMNS =
  "id, accent_hex, neutral_tint_hex, font_family, radius_scale, email_sender_name, support_email, allow_client_override";

function toBrand(r: Raw): DefaultBrand {
  return {
    id: str(r["id"]),
    accentHex: strOrNull(r["accent_hex"]),
    neutralTintHex: strOrNull(r["neutral_tint_hex"]),
    fontFamily: strOrNull(r["font_family"]),
    radiusScale: (strOrNull(r["radius_scale"]) ?? "Default") as RadiusScale,
    emailSenderName: strOrNull(r["email_sender_name"]),
    supportEmail: strOrNull(r["support_email"]),
    allowClientOverride: r["allow_client_override"] !== false,
  };
}

export async function getDefaultBrand(
  db: XosClient,
  partnerOrgId: string,
): Promise<Result<DefaultBrand>> {
  const result = await rows(
    untyped(db)
      .from("partner_default_brands")
      .select(BRAND_COLUMNS)
      .eq("org_id", partnerOrgId)
      .is("deleted_at", null)
      .limit(1),
  );
  if (!result.ok) return result;
  const row = result.data[0];
  return ok(row ? toBrand(row) : EMPTY_DEFAULT_BRAND);
}

export type DefaultBrandInput = Omit<DefaultBrand, "id">;

/** Saves the partner's default client brand, creating it on first save (org.partner.manage). */
export async function saveDefaultBrand(
  db: XosClient,
  partnerOrgId: string,
  input: DefaultBrandInput,
): Promise<Result<string>> {
  const values = {
    accent_hex: input.accentHex,
    neutral_tint_hex: input.neutralTintHex,
    font_family: input.fontFamily,
    radius_scale: input.radiusScale,
    email_sender_name: input.emailSenderName,
    support_email: input.supportEmail,
    allow_client_override: input.allowClientOverride,
  };
  const current = await getDefaultBrand(db, partnerOrgId);
  if (!current.ok) return current;
  if (current.data.id) {
    return writtenId(
      untyped(db)
        .from("partner_default_brands")
        .update(values)
        .eq("id", current.data.id)
        .select("id"),
    );
  }
  return writtenId(
    untyped(db)
      .from("partner_default_brands")
      .insert({ org_id: partnerOrgId, ...values })
      .select("id"),
  );
}

export interface EffectiveBrand {
  readonly accentHex: string | null;
  readonly fontFamily: string | null;
  readonly radiusScale: RadiusScale;
  readonly inherited: boolean;
  readonly overrideAllowed: boolean;
}

/** The brand an org renders with after partner inheritance; null when the caller may not read it. */
export async function getEffectiveBrand(
  db: XosClient,
  orgId: string,
): Promise<Result<EffectiveBrand | null>> {
  return rpc(db, "effective_brand", { p_org_id: orgId }, (data) => {
    const r = ((data as Raw[] | null) ?? [])[0];
    if (!r) return null;
    return {
      accentHex: strOrNull(r["accent_hex"]),
      fontFamily: strOrNull(r["font_family"]),
      radiusScale: (strOrNull(r["radius_scale"]) ?? "Default") as RadiusScale,
      inherited: bool(r["inherited"]),
      overrideAllowed: r["override_allowed"] !== false,
    };
  });
}

// Prices, agreement and wholesale billing -----------------------------------------------------------------

export interface ClientPrice {
  readonly id: string;
  readonly clientOrgId: string;
  readonly monthlyMinor: number;
  readonly currency: string;
}

export async function listClientPrices(
  db: XosClient,
  partnerOrgId: string,
): Promise<Result<ClientPrice[]>> {
  const result = await rows(
    untyped(db)
      .from("partner_client_prices")
      .select("id, client_org_id, monthly_minor, currency_code")
      .eq("org_id", partnerOrgId)
      .is("deleted_at", null),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      id: str(r["id"]),
      clientOrgId: str(r["client_org_id"]),
      monthlyMinor: num(r["monthly_minor"]),
      currency: str(r["currency_code"]),
    })),
  );
}

/** Sets what the partner charges a client each month, replacing any earlier price. */
export async function setClientPrice(
  db: XosClient,
  input: {
    partnerOrgId: string;
    clientOrgId: string;
    monthlyMinor: number;
    currency: string;
  },
): Promise<Result<string>> {
  const current = await listClientPrices(db, input.partnerOrgId);
  if (!current.ok) return current;
  const existing = current.data.find((p) => p.clientOrgId === input.clientOrgId);
  const values = { monthly_minor: input.monthlyMinor, currency_code: input.currency };
  if (existing) {
    return writtenId(
      untyped(db).from("partner_client_prices").update(values).eq("id", existing.id).select("id"),
    );
  }
  return writtenId(
    untyped(db)
      .from("partner_client_prices")
      .insert({ org_id: input.partnerOrgId, client_org_id: input.clientOrgId, ...values })
      .select("id"),
  );
}

export interface PartnerAgreement {
  readonly discountBps: number;
  readonly currency: string;
  readonly signedOn: string;
}

/** The wholesale terms the platform recorded for the partner, or null when there are none yet. */
export async function getPartnerAgreement(
  db: XosClient,
  partnerOrgId: string,
): Promise<Result<PartnerAgreement | null>> {
  const result = await rows(
    untyped(db)
      .from("partner_agreements")
      .select("wholesale_discount_bps, currency_code, signed_on")
      .eq("org_id", partnerOrgId)
      .is("deleted_at", null)
      .limit(1),
  );
  if (!result.ok) return result;
  const r = result.data[0];
  return ok(
    r
      ? {
          discountBps: num(r["wholesale_discount_bps"]),
          currency: str(r["currency_code"]),
          signedOn: str(r["signed_on"]),
        }
      : null,
  );
}

export interface StatementLine {
  readonly clientOrgId: string;
  readonly planCode: string;
  readonly listMinor: number | null;
  readonly wholesaleMinor: number | null;
  readonly clientPriceMinor: number | null;
}

export interface WholesaleStatement {
  readonly id: string;
  readonly periodStart: string;
  readonly currency: string;
  readonly discountBps: number;
  readonly clientCount: number;
  readonly listTotalMinor: number;
  readonly wholesaleTotalMinor: number;
  readonly unpricedCount: number;
  readonly lines: readonly StatementLine[];
}

export async function listWholesaleStatements(
  db: XosClient,
  partnerOrgId: string,
): Promise<Result<WholesaleStatement[]>> {
  const result = await rows(
    untyped(db)
      .from("wholesale_statements")
      .select(
        "id, period_start, currency_code, wholesale_discount_bps, client_count, list_total_minor, wholesale_total_minor, unpriced_count, wholesale_statement_lines (client_org_id, plan_code, list_minor, wholesale_minor, client_price_minor)",
      )
      .eq("org_id", partnerOrgId)
      .is("deleted_at", null)
      .order("period_start", { ascending: false }),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      id: str(r["id"]),
      periodStart: str(r["period_start"]),
      currency: str(r["currency_code"]),
      discountBps: num(r["wholesale_discount_bps"]),
      clientCount: num(r["client_count"]),
      listTotalMinor: num(r["list_total_minor"]),
      wholesaleTotalMinor: num(r["wholesale_total_minor"]),
      unpricedCount: num(r["unpriced_count"]),
      lines: ((r["wholesale_statement_lines"] as Raw[] | null) ?? []).map((l) => ({
        clientOrgId: str(l["client_org_id"]),
        planCode: str(l["plan_code"]),
        listMinor: numOrNull(l["list_minor"]),
        wholesaleMinor: numOrNull(l["wholesale_minor"]),
        clientPriceMinor: numOrNull(l["client_price_minor"]),
      })),
    })),
  );
}

/** Bills the partner for a month (org.billing.manage); returns the statement id. */
export function runWholesaleBilling(
  db: XosClient,
  partnerOrgId: string,
  periodStart: string,
): Promise<Result<string>> {
  return rpc(
    db,
    "run_wholesale_billing",
    { p_partner_org_id: partnerOrgId, p_period_start: periodStart },
    str,
  );
}

export interface UsageTotal {
  readonly orgId: string;
  readonly meter: string;
  readonly quantity: number;
}

export function listClientUsage(
  db: XosClient,
  partnerOrgId: string,
  periodStart: string,
): Promise<Result<UsageTotal[]>> {
  return rpc(
    db,
    "partner_client_usage",
    { p_partner_org_id: partnerOrgId, p_period_start: periodStart },
    (data) =>
      ((data as Raw[] | null) ?? []).map((r) => ({
        orgId: str(r["org_id"]),
        meter: str(r["meter_code"]),
        quantity: num(r["quantity"]),
      })),
  );
}

/** First day of the month of a date, as YYYY-MM-DD in UTC. */
export function monthStart(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// Support sessions -------------------------------------------------------------------------------------------

export interface SupportSession {
  readonly id: string;
  readonly orgId: string;
  readonly granteeOrgId: string;
  readonly reason: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly endedAt: string | null;
  /** True while the session gives access now. */
  readonly open: boolean;
}

/** Support sessions the client org granted, newest first. */
export async function listSupportSessions(
  db: XosClient,
  orgId: string,
  now: Date = new Date(),
): Promise<Result<SupportSession[]>> {
  const result = await rows(
    untyped(db)
      .from("support_sessions")
      .select("id, org_id, grantee_org_id, reason, starts_at, ends_at, ended_at")
      .eq("org_id", orgId)
      // Partner sessions only; platform sessions (A90, 1472) are listed by @xos/data/platform-support.
      .eq("grantee", "Partner")
      .is("deleted_at", null)
      .order("starts_at", { ascending: false })
      .limit(20),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => {
      const endedAt = strOrNull(r["ended_at"]);
      const endsAt = str(r["ends_at"]);
      return {
        id: str(r["id"]),
        orgId: str(r["org_id"]),
        granteeOrgId: str(r["grantee_org_id"]),
        reason: str(r["reason"]),
        startsAt: str(r["starts_at"]),
        endsAt,
        endedAt,
        open: endedAt === null && new Date(endsAt).getTime() > now.getTime(),
      };
    }),
  );
}

/** The client Owner grants its partner a support session of 1 to 24 hours. */
export function grantSupportSession(
  db: XosClient,
  input: { orgId: string; hours: number; reason: string },
): Promise<Result<string>> {
  return rpc(
    db,
    "grant_support_session",
    { p_org_id: input.orgId, p_hours: input.hours, p_reason: input.reason },
    str,
  );
}

export function endSupportSession(db: XosClient, sessionId: string): Promise<Result<string>> {
  return rpc(db, "end_support_session", { p_support_session_id: sessionId }, str);
}

export interface ClientVenue {
  readonly id: string;
  readonly name: string;
  readonly locality: string | null;
}

/**
 * The client's venues as the caller may read them: none for partner staff without a support session,
 * the client's live venues while one is open (row level security decides; archived ones are left out).
 */
export async function listClientVenues(
  db: XosClient,
  clientOrgId: string,
): Promise<Result<ClientVenue[]>> {
  const result = await rows(
    untyped(db)
      .from("venues")
      .select("id, name, locality")
      .eq("org_id", clientOrgId)
      .is("deleted_at", null)
      .is("archived_at", null)
      .order("name")
      .limit(50),
  );
  if (!result.ok) return result;
  return ok(
    result.data.map((r) => ({
      id: str(r["id"]),
      name: str(r["name"]),
      locality: strOrNull(r["locality"]),
    })),
  );
}

/** The partner org of a client org, by id, or null when the org has no partner (its own row, read by a member). */
export async function getPartnerOf(db: XosClient, orgId: string): Promise<Result<string | null>> {
  const result = await rows(
    untyped(db).from("organizations").select("parent_org_id").eq("id", orgId).limit(1),
  );
  if (!result.ok) return result;
  return ok(strOrNull(result.data[0]?.["parent_org_id"]));
}
