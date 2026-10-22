import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Settings repository (Section 4.5.6, Section 12, Section 14.4): resolved settings with their
 * source, shared and personal values, legal acceptances, brand, domains, module switches and
 * favorites. Writes go through the RPCs and policies of migration 0850; the database decides
 * every refusal and this module returns it typed.
 */

type Enums = Database["app"]["Enums"];
export type SettingSource = Enums["setting_source"];
export type SettingScopeKind = Enums["setting_scope"];
export type DomainPurpose = Enums["org_domain_purpose"];
export type DomainVerificationState = Enums["domain_verification_state"];
export type RadiusScale = Enums["brand_radius_scale"];

/** A typed setting value: exactly one of text, boolean or integer for a set value. */
export type SettingValue = string | boolean | number | null;

export interface ResolvedSetting {
  readonly key: string;
  readonly value: SettingValue;
  readonly source: SettingSource;
  readonly locked: boolean;
}

function valueOf(row: {
  value_text: string | null;
  value_boolean: boolean | null;
  value_integer: number | null;
}): SettingValue {
  return row.value_text ?? row.value_boolean ?? row.value_integer ?? null;
}

function valueColumns(
  value: Exclude<SettingValue, null>,
): { p_value_text: string } | { p_value_boolean: boolean } | { p_value_integer: number } {
  if (typeof value === "string") return { p_value_text: value };
  if (typeof value === "boolean") return { p_value_boolean: value };
  return { p_value_integer: value };
}

/** Every registered setting resolved for the signed-in person in an org, keyed by setting key. */
export async function resolveSettings(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly projectId?: string;
    readonly teamId?: string;
    readonly workspaceId?: string;
  },
): Promise<Result<Map<string, ResolvedSetting>>> {
  const { data, error } = await db.rpc("resolve_settings", {
    p_org_id: input.orgId,
    ...(input.projectId ? { p_project_id: input.projectId } : {}),
    ...(input.teamId ? { p_team_id: input.teamId } : {}),
    ...(input.workspaceId ? { p_workspace_id: input.workspaceId } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(
    new Map(
      data.map((row) => [
        row.setting_key,
        { key: row.setting_key, value: valueOf(row), source: row.source, locked: row.locked },
      ]),
    ),
  );
}

export interface StoredSettingValue {
  readonly id: string;
  readonly key: string;
  readonly scopeKind: SettingScopeKind;
  readonly scopeId: string;
  readonly value: SettingValue;
  readonly locked: boolean;
}

/** Values stored for an org at every shared scope, for the override lists on settings pages. */
export async function listSettingValues(
  db: XosClient,
  orgId: string,
): Promise<Result<StoredSettingValue[]>> {
  const { data, error } = await db
    .from("setting_values")
    .select(
      "id, setting_key, scope_kind, scope_id, value_text, value_boolean, value_integer, locked",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: row.id,
      key: row.setting_key,
      scopeKind: row.scope_kind,
      scopeId: row.scope_id,
      value: valueOf(row),
      locked: row.locked,
    })),
  );
}

/**
 * The value an org stored for one setting at its own Organization scope, or null when it stored none.
 * Never a person's own value, which app.resolve_settings ranks above an unlocked org value: org-wide
 * rules (the org's calendar, its payroll week) read the org's row the way the database does
 * (private.org_time_zone, private.setting_text without a person; A71, RRR-116).
 */
export async function getOrgSettingValue(
  db: XosClient,
  orgId: string,
  key: string,
): Promise<Result<SettingValue>> {
  const { data, error } = await db
    .from("setting_values")
    .select("value_text, value_boolean, value_integer")
    .eq("org_id", orgId)
    .eq("setting_key", key)
    .eq("scope_kind", "Organization")
    .eq("scope_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return ok(data ? valueOf(data) : null);
}

/** Sets a value at a shared scope (app.set_setting); the org scope may lock it. */
export async function setSetting(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly key: string;
    readonly scopeKind: SettingScopeKind;
    readonly scopeId: string;
    readonly value: Exclude<SettingValue, null>;
    readonly locked?: boolean;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("set_setting", {
    p_org_id: input.orgId,
    p_setting_key: input.key,
    p_scope_kind: input.scopeKind,
    p_scope_id: input.scopeId,
    ...valueColumns(input.value),
    p_locked: input.locked ?? false,
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** Clears a shared-scope value so the scope inherits again. */
export async function clearSetting(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly key: string;
    readonly scopeKind: SettingScopeKind;
    readonly scopeId: string;
  },
): Promise<Result<boolean>> {
  const { data, error } = await db.rpc("clear_setting", {
    p_org_id: input.orgId,
    p_setting_key: input.key,
    p_scope_kind: input.scopeKind,
    p_scope_id: input.scopeId,
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

/** Sets one of the signed-in person's own settings, for every org or for one org. */
export async function setPersonalSetting(
  db: XosClient,
  input: {
    readonly key: string;
    readonly value: Exclude<SettingValue, null>;
    readonly orgId?: string;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("set_personal_setting", {
    p_setting_key: input.key,
    ...(input.orgId ? { p_org_id: input.orgId } : {}),
    ...valueColumns(input.value),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** Clears one of the signed-in person's own settings. */
export async function clearPersonalSetting(
  db: XosClient,
  input: { readonly key: string; readonly orgId?: string },
): Promise<Result<boolean>> {
  const { data, error } = await db.rpc("clear_personal_setting", {
    p_setting_key: input.key,
    ...(input.orgId ? { p_org_id: input.orgId } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

// Legal acceptances ------------------------------------------------------------------------------

export interface LegalAcceptanceInput {
  readonly slug: string;
  readonly version: string;
}

/** Records accepted document versions (Section 14.4), for an org or personally when orgId is null. */
export async function recordLegalAcceptances(
  db: XosClient,
  input: {
    readonly orgId: string | null;
    readonly documents: readonly LegalAcceptanceInput[];
    readonly clientIp: string | null;
  },
): Promise<Result<number>> {
  const { data, error } = await db.rpc("record_legal_acceptances", {
    p_org_id: input.orgId as string,
    p_document_slugs: input.documents.map((d) => d.slug),
    p_document_versions: input.documents.map((d) => d.version),
    ...(input.clientIp ? { p_client_ip: input.clientIp } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(data);
}

export interface LegalAcceptance {
  readonly documentSlug: string;
  readonly documentVersion: string;
  readonly acceptedAt: string;
  readonly personId: string;
  readonly personName: string | null;
}

/** Acceptances recorded for an org, newest first (Settings > Legal, Owners only by policy). */
export async function listOrgLegalAcceptances(
  db: XosClient,
  orgId: string,
): Promise<Result<LegalAcceptance[]>> {
  const { data, error } = await db
    .from("legal_acceptances")
    .select(
      "document_slug, document_version, accepted_at, person_id, person:people!legal_acceptances_person_id_fkey(full_name)",
    )
    .eq("org_id", orgId)
    .order("accepted_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      documentSlug: row.document_slug,
      documentVersion: row.document_version,
      acceptedAt: row.accepted_at,
      personId: row.person_id,
      personName: row.person?.full_name ?? null,
    })),
  );
}

// Brand -------------------------------------------------------------------------------------------

export interface OrgBrand {
  readonly id: string | null;
  readonly displayName: string | null;
  readonly logoLightPath: string | null;
  readonly logoDarkPath: string | null;
  readonly faviconPath: string | null;
  readonly appIconPath: string | null;
  readonly accentHex: string | null;
  readonly neutralTintHex: string | null;
  readonly fontFamily: string | null;
  readonly radiusScale: RadiusScale;
  readonly emailSenderName: string | null;
  readonly supportEmail: string | null;
  readonly legalEntityName: string | null;
  readonly suppressPoweredBy: boolean;
}

export const EMPTY_BRAND: OrgBrand = {
  id: null,
  displayName: null,
  logoLightPath: null,
  logoDarkPath: null,
  faviconPath: null,
  appIconPath: null,
  accentHex: null,
  neutralTintHex: null,
  fontFamily: null,
  radiusScale: "Default",
  emailSenderName: null,
  supportEmail: null,
  legalEntityName: null,
  suppressPoweredBy: false,
};

const BRAND_COLUMNS =
  "id, display_name, logo_light_path, logo_dark_path, favicon_path, app_icon_path, accent_hex, neutral_tint_hex, font_family, radius_scale, email_sender_name, support_email, legal_entity_name, suppress_powered_by";

/** The org's brand, or the empty brand when none is saved. */
export async function getOrgBrand(db: XosClient, orgId: string): Promise<Result<OrgBrand>> {
  const { data, error } = await db
    .from("org_brands")
    .select(BRAND_COLUMNS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return ok(EMPTY_BRAND);
  return ok({
    id: data.id,
    displayName: data.display_name,
    logoLightPath: data.logo_light_path,
    logoDarkPath: data.logo_dark_path,
    faviconPath: data.favicon_path,
    appIconPath: data.app_icon_path,
    accentHex: data.accent_hex,
    neutralTintHex: data.neutral_tint_hex,
    fontFamily: data.font_family,
    radiusScale: data.radius_scale,
    emailSenderName: data.email_sender_name,
    supportEmail: data.support_email,
    legalEntityName: data.legal_entity_name,
    suppressPoweredBy: data.suppress_powered_by,
  });
}

export type BrandInput = Omit<OrgBrand, "id">;

/** Saves the org's brand, creating it on first save (policy org.white_label.write). */
export async function saveOrgBrand(
  db: XosClient,
  orgId: string,
  brand: BrandInput,
): Promise<Result<null>> {
  const row = {
    display_name: brand.displayName,
    logo_light_path: brand.logoLightPath,
    logo_dark_path: brand.logoDarkPath,
    favicon_path: brand.faviconPath,
    app_icon_path: brand.appIconPath,
    accent_hex: brand.accentHex,
    neutral_tint_hex: brand.neutralTintHex,
    font_family: brand.fontFamily,
    radius_scale: brand.radiusScale,
    email_sender_name: brand.emailSenderName,
    support_email: brand.supportEmail,
    legal_entity_name: brand.legalEntityName,
    suppress_powered_by: brand.suppressPoweredBy,
  };
  const existing = await db
    .from("org_brands")
    .select("id")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (existing.error) return fail(toDataError(existing.error));
  const { error } = existing.data
    ? await db.from("org_brands").update(row).eq("id", existing.data.id)
    : await db.from("org_brands").insert({ ...row, org_id: orgId });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Font families a brand may choose, in display order. */
export async function listBrandFonts(db: XosClient): Promise<Result<string[]>> {
  const { data, error } = await db
    .from("brand_fonts")
    .select("font_family, sort_order")
    .order("sort_order");
  if (error) return fail(toDataError(error));
  return ok(data.flatMap((row) => (row.font_family ? [row.font_family] : [])));
}

// Domains ------------------------------------------------------------------------------------------

export interface OrgDomain {
  readonly id: string;
  readonly hostname: string;
  readonly purpose: DomainPurpose;
  readonly state: DomainVerificationState;
  readonly verificationToken: string;
  readonly verifiedAt: string | null;
  readonly autoJoinRoleId: string | null;
}

/** Domains the org claims, by host name. */
export async function listOrgDomains(db: XosClient, orgId: string): Promise<Result<OrgDomain[]>> {
  const { data, error } = await db
    .from("org_domains")
    .select(
      "id, hostname, purpose, verification_state, verification_token, verified_at, auto_join_role_id",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("hostname");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: row.id,
      hostname: row.hostname,
      purpose: row.purpose,
      state: row.verification_state,
      verificationToken: row.verification_token,
      verifiedAt: row.verified_at,
      autoJoinRoleId: row.auto_join_role_id,
    })),
  );
}

/** Claims a domain; it starts Pending until the verification service checks DNS. */
export async function addOrgDomain(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly hostname: string;
    readonly purpose: DomainPurpose;
    readonly autoJoinRoleId?: string | null;
  },
): Promise<Result<null>> {
  const { error } = await db.from("org_domains").insert({
    org_id: input.orgId,
    hostname: input.hostname.trim().toLowerCase(),
    purpose: input.purpose,
    auto_join_role_id: input.autoJoinRoleId ?? null,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Removes a claimed domain (soft delete). */
export async function removeOrgDomain(db: XosClient, domainId: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("org_domains")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", domainId)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

// Modules ------------------------------------------------------------------------------------------

/** Modules the org turned off; every other module is on. */
export async function listDisabledModules(db: XosClient, orgId: string): Promise<Result<string[]>> {
  const { data, error } = await db
    .from("org_module_states")
    .select("module_code")
    .eq("org_id", orgId)
    .eq("enabled", false)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(data.map((row) => row.module_code).sort());
}

/** Turns a module on or off for the org (needs org.modules.write). */
export async function setModuleEnabled(
  db: XosClient,
  input: { readonly orgId: string; readonly module: string; readonly enabled: boolean },
): Promise<Result<null>> {
  const { error } = await db.rpc("set_module_enabled", {
    p_org_id: input.orgId,
    p_module_code: input.module,
    p_enabled: input.enabled,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

// Favorites ----------------------------------------------------------------------------------------

export interface Favorite {
  readonly id: string;
  readonly nodeId: string;
  readonly targetId: string | null;
  readonly sortOrder: number;
}

/** The signed-in person's favorites in an org, in their order. */
export async function listFavorites(
  db: XosClient,
  input: { readonly orgId: string; readonly personId: string },
): Promise<Result<Favorite[]>> {
  const { data, error } = await db
    .from("favorites")
    .select("id, node_id, target_id, sort_order")
    .eq("org_id", input.orgId)
    .eq("person_id", input.personId)
    .is("deleted_at", null)
    .order("sort_order")
    .order("created_at");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: row.id,
      nodeId: row.node_id,
      targetId: row.target_id,
      sortOrder: row.sort_order,
    })),
  );
}

/** Pins a page (and optionally a record on it) to the person's favorites. */
export async function addFavorite(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly personId: string;
    readonly nodeId: string;
    readonly targetId?: string | null;
    readonly sortOrder?: number;
  },
): Promise<Result<null>> {
  const { error } = await db.from("favorites").insert({
    org_id: input.orgId,
    person_id: input.personId,
    node_id: input.nodeId,
    target_id: input.targetId ?? null,
    sort_order: input.sortOrder ?? 0,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Removes a favorite (soft delete). */
export async function removeFavorite(db: XosClient, favoriteId: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("favorites")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", favoriteId)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

// Persona -------------------------------------------------------------------------------------------

/**
 * The persona the person chose for an org (setting me.persona), preferring a value kept for that
 * org over one kept for every org; null when the person never chose one.
 */
export async function getPersona(db: XosClient, orgId: string): Promise<Result<string | null>> {
  const { data, error } = await db
    .from("personal_setting_values")
    .select("org_id, value_text")
    .eq("setting_key", "me.persona")
    .or(`org_id.is.null,org_id.eq.${orgId}`)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  const forOrg = data.find((row) => row.org_id === orgId);
  return ok((forOrg ?? data[0])?.value_text ?? null);
}
