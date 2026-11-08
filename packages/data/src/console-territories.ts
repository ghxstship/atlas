import type { XosClient } from "./client.ts";
import type { Result } from "./result.ts";
import { bool, rpc, str, strOrNull, type Raw } from "./platform-common.ts";

/**
 * The console's view of where XOS is offered (ADR 0160, migration 6830). Reads need tenants.read; every change needs
 * territories.write and a reason, and lands on the console ledger with the operator. The shells read the offered
 * territories through @xos/i18n/offering instead.
 */

export interface Territory {
  readonly code: string;
  readonly nameEn: string;
  readonly nameEs: string;
  readonly countries: readonly string[];
  readonly currencies: readonly string[];
  readonly locales: readonly string[];
  readonly offered: boolean;
  readonly changedAt: string;
  readonly changedByName: string | null;
  readonly changeReason: string;
}

export interface TerritoryException {
  readonly id: string;
  readonly ownerEmail: string;
  readonly countryCode: string;
  readonly contractReference: string;
  readonly contractSignedOn: string;
  readonly reason: string;
  readonly grantedByName: string | null;
  readonly grantedAt: string;
  readonly orgId: string | null;
  readonly orgName: string | null;
  readonly usedAt: string | null;
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;
}

export interface OrgOutsideTerritories {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly countryCode: string | null;
  /** False for a Gateway company account that has not started Atlas. */
  readonly usesAtlas: boolean;
  readonly exceptionContract: string | null;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] => arr(v).map((s) => str(s));

export async function listTerritories(db: XosClient): Promise<Result<Territory[]>> {
  return rpc(db, "console_list_territories", {}, (data) =>
    arr(data).map((d) => {
      const r = d as Raw;
      return {
        code: str(r["code"]),
        nameEn: str(r["name_en"]),
        nameEs: str(r["name_es"]),
        countries: strings(r["country_codes"]),
        currencies: strings(r["currency_codes"]),
        locales: strings(r["locale_codes"]),
        offered: bool(r["offered"]),
        changedAt: str(r["changed_at"]),
        changedByName: strOrNull(r["changed_by_name"]),
        changeReason: str(r["change_reason"]),
      };
    }),
  );
}

/** Every currency the price book has, for choosing a territory's currencies. */
export async function listPriceBookCurrencies(db: XosClient): Promise<Result<string[]>> {
  return rpc(db, "console_price_book_currencies", {}, (data) =>
    arr(data).map((d) => str((d as Raw)["currency_code"])),
  );
}

/** Adds a territory, or edits one: `isNew` says which, and the save replaces its three lists. */
export async function saveTerritory(
  db: XosClient,
  input: {
    readonly isNew: boolean;
    readonly code: string;
    readonly nameEn: string;
    readonly nameEs: string;
    readonly countries: readonly string[];
    readonly currencies: readonly string[];
    readonly locales: readonly string[];
    readonly reason: string;
  },
): Promise<Result<string>> {
  return rpc(
    db,
    "console_save_territory",
    {
      p_code: input.code,
      p_name_en: input.nameEn,
      p_name_es: input.nameEs,
      p_country_codes: input.countries,
      p_currency_codes: input.currencies,
      p_locale_codes: input.locales,
      p_reason: input.reason,
      p_is_new: input.isNew,
    },
    str,
  );
}

export async function setTerritoryOffered(
  db: XosClient,
  input: { readonly code: string; readonly offered: boolean; readonly reason: string },
): Promise<Result<string>> {
  return rpc(
    db,
    "console_set_territory_offered",
    { p_code: input.code, p_offered: input.offered, p_reason: input.reason },
    str,
  );
}

export async function listTerritoryExceptions(
  db: XosClient,
): Promise<Result<TerritoryException[]>> {
  return rpc(db, "console_list_territory_exceptions", {}, (data) =>
    arr(data).map((d) => {
      const r = d as Raw;
      return {
        id: str(r["id"]),
        ownerEmail: str(r["owner_email"]),
        countryCode: str(r["country_code"]),
        contractReference: str(r["contract_reference"]),
        contractSignedOn: str(r["contract_signed_on"]),
        reason: str(r["reason"]),
        grantedByName: strOrNull(r["granted_by_name"]),
        grantedAt: str(r["granted_at"]),
        orgId: strOrNull(r["org_id"]),
        orgName: strOrNull(r["org_name"]),
        usedAt: strOrNull(r["used_at"]),
        revokedAt: strOrNull(r["revoked_at"]),
        revokeReason: strOrNull(r["revoke_reason"]),
      };
    }),
  );
}

export async function grantTerritoryException(
  db: XosClient,
  input: {
    readonly ownerEmail: string;
    readonly countryCode: string;
    readonly contractReference: string;
    readonly contractSignedOn: string;
    readonly reason: string;
  },
): Promise<Result<string>> {
  return rpc(
    db,
    "console_grant_territory_exception",
    {
      p_owner_email: input.ownerEmail,
      p_country_code: input.countryCode,
      p_contract_reference: input.contractReference,
      p_contract_signed_on: input.contractSignedOn,
      p_reason: input.reason,
    },
    str,
  );
}

export async function revokeTerritoryException(
  db: XosClient,
  input: { readonly id: string; readonly reason: string },
): Promise<Result<string>> {
  return rpc(
    db,
    "console_revoke_territory_exception",
    { p_id: input.id, p_reason: input.reason },
    str,
  );
}

export async function listOrgsOutsideTerritories(
  db: XosClient,
): Promise<Result<OrgOutsideTerritories[]>> {
  return rpc(db, "console_orgs_outside_territories", {}, (data) =>
    arr(data).map((d) => {
      const r = d as Raw;
      return {
        id: str(r["id"]),
        name: str(r["name"]),
        slug: str(r["slug"]),
        countryCode: strOrNull(r["country_code"]),
        usesAtlas: bool(r["uses_atlas"]),
        exceptionContract: strOrNull(r["exception_contract"]),
      };
    }),
  );
}
