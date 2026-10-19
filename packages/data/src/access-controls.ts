import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * The settings features A52 built (RRR-97, migrations 1200 to 1207): org legal entities, the IP
 * allow-list, access reviews, break-glass sessions and blocks. Every read and write runs as the
 * caller, so row level security and the guards decide; refusals come back as typed errors.
 */

// Legal entities ------------------------------------------------------------------------------------

export interface LegalEntity {
  readonly id: string;
  readonly legalName: string;
  readonly countryCode: string;
  /** The identifier in plain text for holders of data.restricted.read.tax, else null. */
  readonly taxIdentifier: string | null;
  readonly taxIdentifierLast4: string | null;
  /** A tax identifier is recorded but the viewer may not read it. */
  readonly taxIdentifierMasked: boolean;
  readonly fiscalYearStartMonth: number;
  readonly baseCurrency: string;
  readonly isPrimary: boolean;
}

export async function listLegalEntities(
  db: XosClient,
  orgId: string,
): Promise<Result<LegalEntity[]>> {
  const { data, error } = await db
    .from("org_legal_entities_masked")
    .select(
      "id, legal_name, country_code, tax_identifier, tax_identifier_last4, is_masked, fiscal_year_start_month, base_currency, is_primary",
    )
    .eq("org_id", orgId)
    .order("is_primary", { ascending: false })
    .order("legal_name");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id ?? "",
      legalName: r.legal_name ?? "",
      countryCode: r.country_code ?? "",
      taxIdentifier: r.tax_identifier,
      taxIdentifierLast4: r.tax_identifier_last4,
      taxIdentifierMasked: r.is_masked === true,
      fiscalYearStartMonth: r.fiscal_year_start_month ?? 1,
      baseCurrency: r.base_currency ?? "",
      isPrimary: r.is_primary === true,
    })),
  );
}

export interface LegalEntityInput {
  readonly orgId: string;
  readonly legalName: string;
  readonly countryCode: string;
  readonly fiscalYearStartMonth: number;
  readonly baseCurrency: string;
  readonly taxIdentifier: string | null;
}

/** Adds a legal entity; the tax identifier goes through the encrypting RPC. */
export async function addLegalEntity(
  db: XosClient,
  input: LegalEntityInput,
): Promise<Result<string>> {
  const { data, error } = await db
    .from("org_legal_entities")
    .insert({
      org_id: input.orgId,
      legal_name: input.legalName,
      country_code: input.countryCode,
      fiscal_year_start_month: input.fiscalYearStartMonth,
      base_currency: input.baseCurrency,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  if (input.taxIdentifier !== null) {
    const tax = await setLegalEntityTaxIdentifier(db, data.id, input.taxIdentifier);
    if (!tax.ok) return tax;
  }
  return ok(data.id);
}

export async function setLegalEntityTaxIdentifier(
  db: XosClient,
  legalEntityId: string,
  taxIdentifier: string | null,
): Promise<Result<string>> {
  const { error } = await db.rpc("set_org_legal_entity_tax_identifier", {
    p_legal_entity_id: legalEntityId,
    // The generated argument type is non-null; NULL clears the identifier.
    p_tax_identifier: taxIdentifier as string,
  });
  if (error) return fail(toDataError(error));
  return ok(legalEntityId);
}

/** Marks a legal entity primary; the database moves the mark off the previous one. */
export async function makeLegalEntityPrimary(
  db: XosClient,
  legalEntityId: string,
): Promise<Result<string>> {
  return updateEntity(db, legalEntityId, { is_primary: true });
}

export async function removeLegalEntity(
  db: XosClient,
  legalEntityId: string,
): Promise<Result<string>> {
  return updateEntity(db, legalEntityId, { deleted_at: new Date().toISOString() });
}

async function updateEntity(
  db: XosClient,
  id: string,
  patch: { is_primary?: boolean; deleted_at?: string },
): Promise<Result<string>> {
  const { data, error } = await db
    .from("org_legal_entities")
    .update(patch)
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  if (data.length === 0) return fail({ kind: "not-found" });
  return ok(id);
}

// IP allow-list -------------------------------------------------------------------------------------

export interface NetworkAccess {
  /** The org enforces its allow-list now. */
  readonly enforced: boolean;
  /** The address may reach the org (inside the list, or the caller holds break-glass). */
  readonly allowed: boolean;
  /** A listed network contains the address, so turning enforcement on keeps the caller in. */
  readonly covered: boolean;
}

/** Whether an address may reach one of the caller's orgs (migration 1201). */
export async function networkAccess(
  db: XosClient,
  orgId: string,
  ip: string | null,
): Promise<Result<NetworkAccess>> {
  const { data, error } = await db.rpc("network_access", { p_org_id: orgId, p_ip: ip ?? "" });
  if (error) return fail(toDataError(error));
  const row = data[0];
  return ok({
    enforced: row?.enforced === true,
    allowed: row === undefined || row.allowed === true,
    covered: row?.covered === true,
  });
}

export interface AllowedNetwork {
  readonly id: string;
  readonly cidr: string;
  readonly label: string;
}

export async function listAllowedNetworks(
  db: XosClient,
  orgId: string,
): Promise<Result<AllowedNetwork[]>> {
  const { data, error } = await db
    .from("org_ip_allowlist")
    .select("id, cidr, label")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("label");
  if (error) return fail(toDataError(error));
  return ok(data.map((r) => ({ id: r.id, cidr: String(r.cidr), label: r.label })));
}

export async function addAllowedNetwork(
  db: XosClient,
  input: { readonly orgId: string; readonly cidr: string; readonly label: string },
): Promise<Result<string>> {
  const { data, error } = await db
    .from("org_ip_allowlist")
    .insert({ org_id: input.orgId, cidr: input.cidr, label: input.label })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok(data.id);
}

export async function removeAllowedNetwork(db: XosClient, id: string): Promise<Result<string>> {
  const { data, error } = await db
    .from("org_ip_allowlist")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  if (data.length === 0) return fail({ kind: "not-found" });
  return ok(id);
}

// Access reviews ------------------------------------------------------------------------------------

export type CampaignState = "Active" | "Complete" | "Canceled";

export interface AccessReviewCampaign {
  readonly id: string;
  readonly name: string;
  readonly dueOn: string;
  readonly autoRemoveUnreviewed: boolean;
  readonly state: CampaignState;
  readonly openedAt: string;
  readonly closedAt: string | null;
}

export async function listAccessReviewCampaigns(
  db: XosClient,
  orgId: string,
): Promise<Result<AccessReviewCampaign[]>> {
  const { data, error } = await db
    .from("access_review_campaigns")
    .select("id, name, due_on, auto_remove_unreviewed, campaign_state, opened_at, closed_at")
    .eq("org_id", orgId)
    .order("opened_at", { ascending: false })
    .limit(20);
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      name: r.name,
      dueOn: r.due_on,
      autoRemoveUnreviewed: r.auto_remove_unreviewed,
      state: r.campaign_state as CampaignState,
      openedAt: r.opened_at,
      closedAt: r.closed_at,
    })),
  );
}

export async function openAccessReview(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly name: string;
    readonly dueOn: string;
    readonly autoRemoveUnreviewed: boolean;
  },
): Promise<Result<string>> {
  const { data, error } = await db
    .from("access_review_campaigns")
    .insert({
      org_id: input.orgId,
      name: input.name,
      due_on: input.dueOn,
      auto_remove_unreviewed: input.autoRemoveUnreviewed,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok(data.id);
}

/** Cancels an Active campaign by deleting it; roles already removed stay removed. */
export async function cancelAccessReview(db: XosClient, id: string): Promise<Result<string>> {
  const { data, error } = await db
    .from("access_review_campaigns")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  if (data.length === 0) return fail({ kind: "not-found" });
  return ok(id);
}

export type ReviewDecision = "Confirmed" | "Removed";

export interface AccessReviewItem {
  readonly id: string;
  readonly personId: string | null;
  readonly personName: string | null;
  readonly roleCode: string | null;
  readonly roleName: string | null;
  readonly roleBand: number | null;
  readonly decision: ReviewDecision | null;
  readonly decidedAt: string | null;
  readonly flaggedAt: string | null;
}

export async function listAccessReviewItems(
  db: XosClient,
  campaignId: string,
): Promise<Result<AccessReviewItem[]>> {
  const { data, error } = await db
    .from("access_review_items")
    .select(
      "id, decision, decided_at, flagged_at, membership_roles(roles(code, name, band), memberships(person_id, people!memberships_person_id_fkey(full_name)))",
    )
    .eq("access_review_campaign_id", campaignId)
    .is("deleted_at", null)
    .order("id");
  if (error) return fail(toDataError(error));
  const items = data.map((r) => {
    const role = r.membership_roles?.roles ?? null;
    const membership = r.membership_roles?.memberships ?? null;
    return {
      id: r.id,
      personId: membership?.person_id ?? null,
      personName: membership?.people?.full_name ?? null,
      roleCode: role?.code ?? null,
      roleName: role?.name ?? null,
      roleBand: role?.band ?? null,
      decision: (r.decision as ReviewDecision | null) ?? null,
      decidedAt: r.decided_at,
      flaggedAt: r.flagged_at,
    };
  });
  // Unreviewed first, then by person, so the reviewer works down one list.
  items.sort(
    (a, b) =>
      Number(a.decision !== null) - Number(b.decision !== null) ||
      (a.personName ?? "").localeCompare(b.personName ?? "") ||
      (a.roleBand ?? 9) - (b.roleBand ?? 9),
  );
  return ok(items);
}

export async function decideAccessReviewItem(
  db: XosClient,
  itemId: string,
  decision: ReviewDecision,
): Promise<Result<string>> {
  const { data, error } = await db
    .from("access_review_items")
    .update({ decision })
    .eq("id", itemId)
    .select("id");
  if (error) return fail(toDataError(error));
  if (data.length === 0) return fail({ kind: "not-found" });
  return ok(itemId);
}

// Break-glass -----------------------------------------------------------------------------------------

export interface BreakGlassSession {
  readonly id: string;
  readonly personId: string;
  readonly reason: string;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly endedAt: string | null;
}

export async function listBreakGlassSessions(
  db: XosClient,
  orgId: string,
): Promise<Result<BreakGlassSession[]>> {
  const { data, error } = await db
    .from("break_glass_sessions")
    .select("id, person_id, reason, started_at, expires_at, ended_at")
    .eq("org_id", orgId)
    .order("started_at", { ascending: false })
    .limit(10);
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      personId: r.person_id,
      reason: r.reason,
      startedAt: r.started_at,
      expiresAt: r.expires_at,
      endedAt: r.ended_at,
    })),
  );
}

/** Whether a session is open at `now`. */
export function breakGlassOpen(session: BreakGlassSession, now: Date = new Date()): boolean {
  return session.endedAt === null && new Date(session.expiresAt).getTime() > now.getTime();
}

export async function startBreakGlass(
  db: XosClient,
  orgId: string,
  reason: string,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("start_break_glass", { p_org_id: orgId, p_reason: reason });
  if (error) return fail(toDataError(error));
  return ok(data.id);
}

export async function endBreakGlass(db: XosClient, sessionId: string): Promise<Result<string>> {
  const { error } = await db.rpc("end_break_glass", { p_session_id: sessionId });
  if (error) return fail(toDataError(error));
  return ok(sessionId);
}

// Blocks ------------------------------------------------------------------------------------------------

export interface Block {
  readonly id: string;
  readonly kind: "person" | "organization";
  readonly handle: string | null;
  readonly name: string | null;
}

export async function listMyBlocks(db: XosClient): Promise<Result<Block[]>> {
  const { data, error } = await db.rpc("my_blocks");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      kind: r.blocked_kind === "organization" ? ("organization" as const) : ("person" as const),
      handle: r.blocked_handle,
      name: r.blocked_name,
    })),
  );
}

export async function blockProfile(
  db: XosClient,
  kind: "person" | "organization",
  handle: string,
): Promise<Result<string>> {
  const { data, error } = await db.rpc("block_profile", { p_kind: kind, p_handle: handle });
  if (error) return fail(toDataError(error));
  return ok(data);
}

export async function unblock(db: XosClient, blockId: string): Promise<Result<string>> {
  const { data, error } = await db
    .from("blocks")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", blockId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  if (data.length === 0) return fail({ kind: "not-found" });
  return ok(blockId);
}
