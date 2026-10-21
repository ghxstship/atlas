import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, XosClient } from "./client.ts";
import { csvField } from "./csv.ts";
import { fillPersonNames } from "./person-names.ts";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result.ts";

/**
 * Finance repository (Sections 3.7, 3.11, 7.4 and 8.1 to 8.2): budgets and budget lines, expenses,
 * contingency draws, change orders, invoices, payments, the journal, accounting periods, cost
 * centers, the chart of accounts and the Universal Posting Line. Reads go through row level
 * security; every state change goes through A03's RPCs (0320, 0321), which enforce spend authority
 * and separation of duties and refuse with SQLSTATE XR001. Money is integer minor units, and null is
 * unpriced, never zero: no function here coerces a blank amount.
 */

type Enums = Database["app"]["Enums"];
export type ExpenseState = Enums["expense_state"];
export type ChangeOrderState = Enums["change_order_state"];
export type InvoiceState = Enums["invoice_state"];
export type PaymentState = Enums["payment_state"];
export type JournalState = Enums["journal_state"];
export type PeriodState = Enums["accounting_period_state"];
export type BudgetLineType = Enums["budget_line_type"];
export type CostCenterKind = Enums["cost_center_kind"];
export type MoneyDirection = Enums["money_direction"];
export type XyzTag = "X" | "Y" | "Z";

export const EXPENSE_STATES: readonly ExpenseState[] = [
  "Proposed",
  "Approved",
  "Rejected",
  "Paid",
  "Canceled",
];
export const CHANGE_ORDER_STATES: readonly ChangeOrderState[] = [
  "Proposed",
  "Priced",
  "Approved",
  "Rejected",
  "Canceled",
];
export const INVOICE_STATES: readonly InvoiceState[] = [
  "Proposed",
  "Issued",
  "Approved",
  "Disputed",
  "Canceled",
];
export const PAYMENT_STATES: readonly PaymentState[] = ["Proposed", "Approved", "Canceled"];
export const JOURNAL_STATES: readonly JournalState[] = ["Proposed", "Posted", "Canceled"];
export const PERIOD_STATES: readonly PeriodState[] = [
  "Open",
  "In Period",
  "Closing",
  "Closed",
  "Audited",
  "Archived",
];
export const BUDGET_LINE_TYPES: readonly BudgetLineType[] = ["Cost", "Labor", "Fee", "Contingency"];
export const COST_CENTER_KINDS: readonly CostCenterKind[] = ["Standing", "Overhead", "Event"];

/**
 * The next states a lifecycle allows from a state, as A03's transition rules declare them (0320,
 * 0321). The database still decides every move; the pages use this to offer only valid actions.
 */
export const NEXT_STATES = {
  expense: {
    Proposed: ["Approved", "Rejected", "Canceled"],
    Rejected: ["Proposed"],
    Approved: ["Paid"],
    Paid: [],
    Canceled: [],
  },
  change_order: {
    Proposed: ["Priced", "Canceled"],
    Priced: ["Proposed", "Approved", "Rejected", "Canceled"],
    Rejected: ["Proposed"],
    Approved: [],
    Canceled: [],
  },
  invoice: {
    Proposed: ["Issued", "Approved", "Canceled"],
    Issued: ["Disputed", "Canceled"],
    Approved: ["Disputed"],
    Disputed: ["Issued", "Approved", "Canceled"],
    Canceled: [],
  },
  payment: { Proposed: ["Approved", "Canceled"], Approved: [], Canceled: [] },
  journal: { Proposed: ["Posted", "Canceled"], Posted: [], Canceled: [] },
  accounting_period: {
    Open: ["In Period"],
    "In Period": ["Closing"],
    Closing: ["In Period", "Closed"],
    Closed: ["Audited"],
    Audited: ["Archived"],
    Archived: [],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>;

// Shared helpers ------------------------------------------------------------------------------------

/** The three 0480 views are newer than the committed generated types; they are read untyped. */
function untyped(db: XosClient): SupabaseClient {
  return db as unknown as SupabaseClient;
}

type Raw = Record<string, unknown>;

async function rows<T>(
  query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
  map: (row: Raw) => T,
): Promise<Result<T[]>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok(((data as Raw[] | null) ?? []).map(map));
}

async function one<T>(
  query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
  map: (row: Raw) => T,
): Promise<Result<T>> {
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(map(data as Raw));
}

async function done(
  query: PromiseLike<{ error: DatabaseErrorLike | null }>,
): Promise<Result<null>> {
  const { error } = await query;
  return error ? fail(toDataError(error)) : ok(null);
}

async function rpcValue<T>(
  query: PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
): Promise<Result<T>> {
  const { data, error } = await query;
  return error ? fail(toDataError(error)) : ok(data as T);
}

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : typeof v === "number" ? v : Number(v);
const obj = (v: unknown): Raw | null =>
  Array.isArray(v) ? ((v[0] as Raw | undefined) ?? null) : ((v as Raw | null) ?? null);
const now = () => new Date().toISOString();

/** Sum of amounts where any blank makes the total blank (Section 3.7), with the blank count. */
export function nullAwareSum(amounts: readonly (number | null)[]): {
  total: number | null;
  priced: number | null;
  unpricedCount: number;
} {
  let priced = 0;
  let pricedCount = 0;
  let unpricedCount = 0;
  for (const a of amounts) {
    if (a === null) unpricedCount += 1;
    else {
      priced += a;
      pricedCount += 1;
    }
  }
  return {
    total: unpricedCount > 0 || amounts.length === 0 ? null : priced,
    priced: pricedCount === 0 ? null : priced,
    unpricedCount,
  };
}

/** Quantity times unit price in minor units, rounded half away from zero; null stays null. */
export function extendedMinor(quantity: number, unitPriceMinor: number | null): number | null {
  if (unitPriceMinor === null) return null;
  const v = quantity * unitPriceMinor;
  return Math.sign(v) * Math.round(Math.abs(v));
}

/**
 * Converts minor units between currencies at a rate (units of `to` per unit of `from`), honoring
 * each currency's minor unit exponent. Null stays null: an unpriced amount is never converted to 0.
 */
export function convertMinor(
  amountMinor: number | null,
  rate: number,
  fromExponent: number,
  toExponent: number,
): number | null {
  if (amountMinor === null) return null;
  const v = (amountMinor / 10 ** fromExponent) * rate * 10 ** toExponent;
  return Math.sign(v) * Math.round(Math.abs(v));
}

/** Major units for display components that format major units; null stays null. */
export function toMajor(amountMinor: number | null, exponent: number): number | null {
  return amountMinor === null ? null : amountMinor / 10 ** exponent;
}

/** Parses a typed money amount in major units to minor units; blank is null (unpriced). */
export function parseMoney(text: string, exponent: number): number | null | "invalid" {
  const trimmed = text.trim().replace(/[\s,$]/g, "");
  if (trimmed === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return "invalid";
  const [whole = "0", fraction = ""] = trimmed.replace("-", "").split(".");
  if (fraction.length > exponent) return "invalid";
  const minor = Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, "0") || "0");
  return trimmed.startsWith("-") ? -minor : minor;
}

export interface Transition {
  readonly id: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

type Ledger =
  | "expense_state_transitions"
  | "change_order_state_transitions"
  | "invoice_state_transitions"
  | "payment_state_transitions"
  | "journal_state_transitions"
  | "accounting_period_state_transitions"
  | "settlement_state_transitions";

const LEDGER_COLUMN: Record<Ledger, string> = {
  expense_state_transitions: "expense_id",
  change_order_state_transitions: "change_order_id",
  invoice_state_transitions: "invoice_id",
  payment_state_transitions: "payment_id",
  journal_state_transitions: "journal_entry_id",
  accounting_period_state_transitions: "accounting_period_id",
  settlement_state_transitions: "settlement_id",
};

/** The state ledger of one subject, oldest first: the record's activity for every lifecycle. */
export async function listTransitions(
  db: XosClient,
  ledger: Ledger,
  subjectId: string,
): Promise<Result<Transition[]>> {
  return rows(
    untyped(db)
      .from(ledger)
      .select("id, from_state, to_state, reason, created_at, created_by")
      .eq(LEDGER_COLUMN[ledger], subjectId)
      .order("created_at", { ascending: true }),
    (r) => ({
      id: str(r["id"]),
      fromState: strOrNull(r["from_state"]),
      toState: str(r["to_state"]),
      reason: str(r["reason"]),
      createdAt: str(r["created_at"]),
      createdBy: strOrNull(r["created_by"]),
    }),
  );
}

// Reference data ------------------------------------------------------------------------------------

export interface ProjectRef {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly productionState: string;
  /** ISO 4217 base currency of the project, the default for its budgets. */
  readonly currency: string;
}

const toProject = (r: Raw): ProjectRef => ({
  id: str(r["id"]),
  key: str(r["project_key"]),
  name: str(r["name"]),
  productionState: str(r["production_state"]),
  currency: str(r["currency"]).trim(),
});

/** Projects of the org the viewer may read, in project key order. */
export async function listProjects(db: XosClient, orgId: string): Promise<Result<ProjectRef[]>> {
  return rows(
    db
      .from("projects")
      .select("id, project_key, name, production_state, currency")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("project_key"),
    toProject,
  );
}

/** One project by its key, or not-found when it is missing or hidden from the viewer. */
export async function getProjectByKey(
  db: XosClient,
  orgId: string,
  key: string,
): Promise<Result<ProjectRef>> {
  return one(
    db
      .from("projects")
      .select("id, project_key, name, production_state, currency")
      .eq("org_id", orgId)
      .eq("project_key", key)
      .is("deleted_at", null)
      .maybeSingle(),
    toProject,
  );
}

export interface CounterpartyRef {
  readonly id: string;
  readonly name: string | null;
  readonly type: string | null;
}

/** Counterparties (vendors and clients) of the org; the name is A03's computed field over the organization. */
export async function listCounterparties(
  db: XosClient,
  orgId: string,
): Promise<Result<CounterpartyRef[]>> {
  const result = await rows(
    db
      .from("counterparties")
      .select("id, counterparty_type, counterparty_name")
      .eq("org_id", orgId)
      .is("deleted_at", null),
    (r) => ({
      id: str(r["id"]),
      name: strOrNull(r["counterparty_name"]),
      type: strOrNull(r["counterparty_type"]),
    }),
  );
  if (!result.ok) return result;
  return ok(result.data.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")));
}

export interface UridOption {
  readonly urid: string;
  readonly name: string;
  /** XYZ tag of a category; null for a discipline, whose tag is declared per line. */
  readonly xyz: XyzTag | null;
}

/** Canon disciplines and categories (dimension 2), in numeric URID order. */
export async function listUridOptions(db: XosClient): Promise<Result<UridOption[]>> {
  const canon = db.schema("xpms");
  const [disciplines, categories] = await Promise.all([
    rows(canon.from("dim_discipline").select("disc_code, discipline"), (r) => ({
      urid: str(r["disc_code"]),
      name: str(r["discipline"]),
      xyz: null,
    })),
    rows(canon.from("dim_category").select("cat_urid, category, xyz"), (r) => ({
      urid: str(r["cat_urid"]),
      name: str(r["category"]),
      xyz: (strOrNull(r["xyz"])?.trim() as XyzTag | undefined) ?? null,
    })),
  ]);
  if (!disciplines.ok) return disciplines;
  if (!categories.ok) return categories;
  return ok(
    [...disciplines.data, ...categories.data].sort((a, b) =>
      a.urid.localeCompare(b.urid, "en", { numeric: true }),
    ),
  );
}

export interface GlAccount {
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly classCode: string | null;
  readonly taxType: string;
  readonly description: string | null;
}

/** The fixed 23-account chart (Bible tab 29), in account code order. Tenants never add accounts. */
export async function listGlAccounts(db: XosClient): Promise<Result<GlAccount[]>> {
  return rows(
    db
      .schema("xpms")
      .from("dim_gl_account")
      .select("account_code, account_name, account_type, class_code, tax_type, description")
      .order("account_code"),
    (r) => ({
      code: str(r["account_code"]),
      name: str(r["account_name"]),
      type: str(r["account_type"]),
      classCode: strOrNull(r["class_code"]),
      taxType: str(r["tax_type"]),
      description: strOrNull(r["description"]),
    }),
  );
}

/** The account a URID posts to: its class's one account of the type (decision D13), or null. */
export function accountForUrid(
  urid: string,
  accounts: readonly GlAccount[],
  type = "Expense",
): GlAccount | null {
  return accounts.find((a) => a.classCode === urid.slice(0, 4) && a.type === type) ?? null;
}

export interface CanonOption {
  readonly id: string;
  readonly code: string;
  readonly label: string;
}

/** The canon Order Type enumeration change orders use, in sort order. */
export async function listOrderTypes(db: XosClient): Promise<Result<CanonOption[]>> {
  return rows(
    db
      .schema("xpms")
      .from("std_enumeration")
      .select("record_id, enum_code, enum_label")
      .eq("enum_domain", "Order Type")
      .order("sort_order"),
    (r) => ({ id: str(r["record_id"]), code: str(r["enum_code"]), label: str(r["enum_label"]) }),
  );
}

export interface Grade {
  readonly code: string;
  readonly label: string;
}

/** Price grades (decision D11): Base, Elevated, Premium, in canon order. */
export async function listGrades(db: XosClient): Promise<Result<Grade[]>> {
  return rows(db.schema("xpms").from("grade").select("code, label").order("sort_order"), (r) => ({
    code: str(r["code"]),
    label: str(r["label"]),
  }));
}

export interface CatalogElement {
  readonly elementId: string;
  readonly urid: string;
  readonly name: string;
  readonly unitBasis: string | null;
  readonly xyz: XyzTag | null;
  /** Price per grade in minor units of `currency`; a missing grade is unpriced (null). */
  readonly prices: Readonly<Record<string, number | null>>;
  readonly currency: string | null;
}

/**
 * Catalog elements matching a search, with their current price band per grade. An element without
 * a band for a grade is unpriced at that grade, never priced at zero (Section 20.2 journey 3).
 */
export async function searchCatalogElements(
  db: XosClient,
  input: { readonly search: string; readonly limit?: number; readonly on?: string },
): Promise<Result<CatalogElement[]>> {
  const canon = db.schema("xpms");
  const term = input.search.trim().replace(/[%,()]/g, " ");
  let query = canon
    .from("elements")
    .select("element_id, urid, item, common_name, unit_basis, xyz")
    .order("element_id")
    .limit(input.limit ?? 25);
  if (term !== "")
    query = query.or(`item.ilike.%${term}%,common_name.ilike.%${term}%,urid.ilike.${term}%`);
  const elements = await rows(query, (r) => ({
    elementId: str(r["element_id"]),
    urid: str(r["urid"]),
    name: strOrNull(r["common_name"]) ?? str(r["item"]),
    unitBasis: strOrNull(r["unit_basis"]),
    xyz: (strOrNull(r["xyz"])?.trim() as XyzTag | undefined) ?? null,
  }));
  if (!elements.ok) return elements;
  if (elements.data.length === 0) return ok([]);
  const on = input.on ?? now().slice(0, 10);
  const bands = await rows(
    canon
      .from("element_price_bands")
      .select("element_id, grade_code, amount_minor, currency_code, valid_from, valid_to")
      .in(
        "element_id",
        elements.data.map((e) => e.elementId),
      ),
    (r) => ({
      elementId: str(r["element_id"]),
      grade: str(r["grade_code"]),
      amount: numOrNull(r["amount_minor"]),
      currency: strOrNull(r["currency_code"])?.trim() ?? null,
      validFrom: strOrNull(r["valid_from"]),
      validTo: strOrNull(r["valid_to"]),
    }),
  );
  if (!bands.ok) return bands;
  return ok(
    elements.data.map((e) => {
      const live = bands.data.filter(
        (b) =>
          b.elementId === e.elementId &&
          (b.validFrom === null || b.validFrom <= on) &&
          (b.validTo === null || b.validTo >= on),
      );
      const prices: Record<string, number | null> = {};
      for (const b of live) prices[b.grade] = b.amount;
      return { ...e, prices, currency: live[0]?.currency ?? null };
    }),
  );
}

export interface ScopeNodeRef {
  readonly id: string;
  readonly projectId: string;
  readonly code: string;
  readonly name: string;
}

/** Scope nodes of the org's readable projects, for Event cost centers. */
export async function listScopeNodes(
  db: XosClient,
  orgId: string,
): Promise<Result<ScopeNodeRef[]>> {
  return rows(
    db
      .from("scope_nodes")
      .select("id, project_id, scope_code, name")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("scope_code"),
    (r) => ({
      id: str(r["id"]),
      projectId: str(r["project_id"]),
      code: str(r["scope_code"]),
      name: str(r["name"]),
    }),
  );
}

export interface Currency {
  readonly code: string;
  readonly exponent: number;
}

/** ISO 4217 currencies with their minor unit exponent (private.currencies through app.currencies). */
export async function listCurrencies(db: XosClient): Promise<Result<Currency[]>> {
  return rows(
    untyped(db)
      .from("currencies")
      .select("currency_code, minor_unit_exponent")
      .order("currency_code"),
    (r) => ({ code: str(r["currency_code"]).trim(), exponent: num(r["minor_unit_exponent"]) }),
  );
}

export interface FxRate {
  readonly id: string;
  readonly base: string;
  readonly quote: string;
  readonly rate: number;
  readonly effectiveOn: string;
  readonly source: string;
}

/** Exchange rates of the org, newest first. */
export async function listFxRates(db: XosClient, orgId: string): Promise<Result<FxRate[]>> {
  return rows(
    db
      .from("fx_rates")
      .select("id, base_currency, quote_currency, rate, effective_on, source")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("effective_on", { ascending: false }),
    (r) => ({
      id: str(r["id"]),
      base: str(r["base_currency"]).trim(),
      quote: str(r["quote_currency"]).trim(),
      rate: num(r["rate"]),
      effectiveOn: str(r["effective_on"]),
      source: str(r["source"]),
    }),
  );
}

/** A rate answering one conversion: the rate, the day it is from and where it came from. */
export interface FxAnswer {
  readonly rate: number;
  /** The rate's date (for a rate through EUR, the older of its two legs). */
  readonly effectiveOn: string;
  readonly source: string;
  /** The currency a cross rate goes through (EUR for ECB reference rates), when it is one. */
  readonly via?: string;
}

/** The latest direct (or inverted opposite) rate on or before a day, or null. */
function directFxRate(
  rates: readonly FxRate[],
  from: string,
  to: string,
  on: string,
): FxAnswer | null {
  const candidates = rates
    .filter((r) => r.effectiveOn <= on)
    .flatMap((r) =>
      r.base === from && r.quote === to
        ? [{ rate: r.rate, effectiveOn: r.effectiveOn, source: r.source }]
        : r.base === to && r.quote === from
          ? [{ rate: 1 / r.rate, effectiveOn: r.effectiveOn, source: r.source }]
          : [],
    )
    .sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn));
  return candidates[0] ?? null;
}

/** The currency ECB reference rates are quoted against (one euro buys `rate` of each currency). */
export const FX_CROSS_CURRENCY = "EUR";

/**
 * The latest rate on or before a day converting `from` to `to`: a stored pair, the inverse of a stored
 * opposite pair, or a cross rate through EUR (ECB publishes every currency against the euro), whichever is
 * most recent, a stored pair winning a tie. A conversion for a business date uses that date's rate or the
 * last one before it. Null is no answer: a missing rate never converts.
 */
export function findFxRate(
  rates: readonly FxRate[],
  from: string,
  to: string,
  on: string,
): FxAnswer | null {
  if (from === to) return { rate: 1, effectiveOn: on, source: "" };
  const direct = directFxRate(rates, from, to, on);
  if (from === FX_CROSS_CURRENCY || to === FX_CROSS_CURRENCY) return direct;
  const toCross = directFxRate(rates, from, FX_CROSS_CURRENCY, on);
  const fromCross = directFxRate(rates, FX_CROSS_CURRENCY, to, on);
  const cross: FxAnswer | null =
    toCross && fromCross
      ? {
          rate: toCross.rate * fromCross.rate,
          effectiveOn:
            toCross.effectiveOn < fromCross.effectiveOn
              ? toCross.effectiveOn
              : fromCross.effectiveOn,
          source:
            toCross.source === fromCross.source
              ? toCross.source
              : `${toCross.source}, ${fromCross.source}`,
          via: FX_CROSS_CURRENCY,
        }
      : null;
  if (!cross) return direct;
  if (!direct) return cross;
  return cross.effectiveOn > direct.effectiveOn ? cross : direct;
}

/**
 * A rate older than this many days on the business date it converts for is shown as stale. ECB publishes on
 * TARGET business days, so a Thursday rate is still the latest on the Tuesday after Easter: five days.
 */
export const FX_STALE_AFTER_DAYS = 5;

/** Whole days from a rate's date to the business date it converts for (both calendar dates). */
export function fxRateAgeDays(effectiveOn: string, on: string): number {
  const day = (iso: string) =>
    Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((day(on) - day(effectiveOn)) / 86_400_000);
}

/** Whether a rate is too old to show without saying so. */
export function isFxRateStale(effectiveOn: string, on: string): boolean {
  return fxRateAgeDays(effectiveOn, on) > FX_STALE_AFTER_DAYS;
}

/** The latest rate of each currency pair, newest first, for a table that should not list every day. */
export function latestFxRates(rates: readonly FxRate[]): FxRate[] {
  const seen = new Set<string>();
  return [...rates]
    .sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn))
    .filter((r) => {
      const key = `${r.base}/${r.quote}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The daily reference rate feed's state (app.fx_feed_status, migration 1542). */
export interface FxFeedStatus {
  readonly lastSuccessAt: string | null;
  /** The ECB publication date of the newest rates the feed wrote. */
  readonly lastRateDate: string | null;
  readonly lastFailureAt: string | null;
  readonly lastError: string | null;
  /** Failed runs since the last success: more than zero means the newest rates may be missing. */
  readonly failuresSinceSuccess: number;
}

/** The state of a reference rate feed (ECB by default) for honest rate dates on finance pages. */
export async function getFxFeedStatus(
  db: XosClient,
  source = "ECB",
): Promise<Result<FxFeedStatus>> {
  const { data, error } = await db.rpc("fx_feed_status", { p_source: source });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  return ok({
    lastSuccessAt: text(row?.["last_success_at"]),
    lastRateDate: text(row?.["last_rate_date"]),
    lastFailureAt: text(row?.["last_failure_at"]),
    lastError: text(row?.["last_error"]),
    failuresSinceSuccess: Number(row?.["failures_since_success"] ?? 0),
  });
}

/** Records an exchange rate. Needs finance.cost_center.write. */
export async function createFxRate(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly base: string;
    readonly quote: string;
    readonly rate: number;
    readonly effectiveOn: string;
    readonly source: string;
  },
): Promise<Result<null>> {
  return done(
    db.from("fx_rates").insert({
      org_id: input.orgId,
      base_currency: input.base,
      quote_currency: input.quote,
      rate: input.rate,
      effective_on: input.effectiveOn,
      source: input.source.trim(),
    }),
  );
}

// Cost centers -----------------------------------------------------------------------------------------

export interface CostCenter {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: CostCenterKind;
  readonly scopeNodeId: string | null;
  readonly templateId: string | null;
}

const toCostCenter = (r: Raw): CostCenter => ({
  id: str(r["id"]),
  code: str(r["code"]),
  name: str(r["name"]),
  kind: str(r["kind"]) as CostCenterKind,
  scopeNodeId: strOrNull(r["scope_node_id"]),
  templateId: strOrNull(r["template_id"]),
});

/** Cost centers of the org (dimension 1), in code order. */
export async function listCostCenters(db: XosClient, orgId: string): Promise<Result<CostCenter[]>> {
  const result = await rows(
    db
      .from("cost_centers")
      .select("id, code, name, kind, scope_node_id, template_id")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("code"),
    toCostCenter,
  );
  if (!result.ok) return result;
  return ok(result.data.sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true })));
}

export interface CostCenterInput {
  readonly code: string;
  readonly name: string;
  readonly kind: CostCenterKind;
  readonly scopeNodeId: string | null;
}

/** Adds a cost center. An Event cost center names its event scope node. */
export async function createCostCenter(
  db: XosClient,
  orgId: string,
  input: CostCenterInput,
): Promise<Result<{ id: string }>> {
  return one(
    db
      .from("cost_centers")
      .insert({
        org_id: orgId,
        code: input.code.trim().toUpperCase(),
        name: input.name.trim(),
        kind: input.kind,
        scope_node_id: input.kind === "Event" ? input.scopeNodeId : null,
      })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function updateCostCenter(
  db: XosClient,
  id: string,
  input: CostCenterInput,
): Promise<Result<null>> {
  return done(
    db
      .from("cost_centers")
      .update({
        code: input.code.trim().toUpperCase(),
        name: input.name.trim(),
        kind: input.kind,
        scope_node_id: input.kind === "Event" ? input.scopeNodeId : null,
      })
      .eq("id", id),
  );
}

/** Soft deletes a cost center; posted lines keep their reference. */
export async function deleteCostCenter(db: XosClient, id: string): Promise<Result<null>> {
  return done(db.from("cost_centers").update({ deleted_at: now() }).eq("id", id));
}

// Budgets ----------------------------------------------------------------------------------------------

export interface BudgetSummary {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string | null;
  readonly projectName: string | null;
  readonly name: string;
  readonly currency: string;
  readonly isBaseline: boolean;
  readonly lineCount: number;
  readonly unpricedCount: number;
  readonly pricedTotalMinor: number | null;
  readonly totalMinor: number | null;
  readonly approvedChangeCount: number;
  readonly approvedChangeMinor: number;
  readonly revisedTotalMinor: number | null;
  readonly actualMinor: number;
  readonly updatedAt: string;
}

/** Budgets of the org, or of one project, with their NULL-aware totals revised by approved change orders. */
export async function listBudgets(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<BudgetSummary[]>> {
  let query = db
    .from("budgets")
    .select(
      "id, project_id, name, currency_code, is_baseline, updated_at, project:projects(project_key, name)",
    )
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (input.projectId) query = query.eq("project_id", input.projectId);
  const budgets = await rows(query, (r) => r);
  if (!budgets.ok) return budgets;
  if (budgets.data.length === 0) return ok([]);
  const totals = await rows(
    untyped(db)
      .from("budget_revised_totals")
      .select("*")
      .in(
        "budget_id",
        budgets.data.map((b) => str(b["id"])),
      ),
    (r) => r,
  );
  if (!totals.ok) return totals;
  const byId = new Map(totals.data.map((t) => [str(t["budget_id"]), t]));
  return ok(
    budgets.data.map((b): BudgetSummary => {
      const t = byId.get(str(b["id"])) ?? {};
      const project = obj(b["project"]);
      return {
        id: str(b["id"]),
        projectId: str(b["project_id"]),
        projectKey: strOrNull(project?.["project_key"]),
        projectName: strOrNull(project?.["name"]),
        name: str(b["name"]),
        currency: str(b["currency_code"]).trim(),
        isBaseline: b["is_baseline"] === true,
        lineCount: num(t["line_count"]),
        unpricedCount: num(t["unpriced_count"]),
        pricedTotalMinor: numOrNull(t["priced_total_minor"]),
        totalMinor: numOrNull(t["total_minor"]),
        approvedChangeCount: num(t["approved_change_count"]),
        approvedChangeMinor: num(t["approved_change_minor"]),
        revisedTotalMinor: numOrNull(t["revised_total_minor"]),
        actualMinor: num(t["actual_minor"]),
        updatedAt: str(b["updated_at"]),
      };
    }),
  );
}

export interface BudgetLine {
  readonly id: string;
  readonly budgetId: string;
  readonly lineNumber: number;
  readonly description: string;
  readonly lineType: BudgetLineType;
  readonly urid: string;
  readonly costCenterId: string | null;
  readonly gradeCode: string | null;
  readonly elementId: string | null;
  readonly quantity: number;
  readonly unitBasis: string | null;
  readonly unitPriceMinor: number | null;
  readonly xyz: XyzTag;
  readonly xyzBasis: "Category" | "Declared";
  readonly extendedMinor: number | null;
  readonly accountCode: string | null;
  readonly actualMinor: number;
  readonly drawnInMinor: number;
  readonly drawnOutMinor: number;
  /** The version the row was read at, for conflict checks on save. */
  readonly updatedAt: string;
}

const LINE_COLUMNS =
  "id, budget_id, line_number, description, line_type, urid, cost_center_id, grade_code, element_id, quantity, unit_basis, unit_price_minor, xyz, xyz_basis, updated_at";

function toLine(r: Raw, amounts?: Raw): BudgetLine {
  const quantity = num(r["quantity"]);
  const unitPrice = numOrNull(r["unit_price_minor"]);
  return {
    id: str(r["id"]),
    budgetId: str(r["budget_id"]),
    lineNumber: num(r["line_number"]),
    description: str(r["description"]),
    lineType: str(r["line_type"]) as BudgetLineType,
    urid: str(r["urid"]),
    costCenterId: strOrNull(r["cost_center_id"]),
    gradeCode: strOrNull(r["grade_code"]),
    elementId: strOrNull(r["element_id"]),
    quantity,
    unitBasis: strOrNull(r["unit_basis"]),
    unitPriceMinor: unitPrice,
    xyz: str(r["xyz"]).trim() as XyzTag,
    xyzBasis: str(r["xyz_basis"]) as "Category" | "Declared",
    extendedMinor: amounts
      ? numOrNull(amounts["extended_minor"])
      : extendedMinor(quantity, unitPrice),
    accountCode: amounts ? strOrNull(amounts["account_code"]) : null,
    actualMinor: amounts ? num(amounts["actual_minor"]) : 0,
    drawnInMinor: amounts ? num(amounts["drawn_in_minor"]) : 0,
    drawnOutMinor: amounts ? num(amounts["drawn_out_minor"]) : 0,
    updatedAt: str(r["updated_at"]),
  };
}

export interface BudgetDetail {
  readonly budget: BudgetSummary;
  readonly lines: readonly BudgetLine[];
}

/** One budget with its live lines in line order and their derived amounts. */
export async function getBudget(
  db: XosClient,
  orgId: string,
  budgetId: string,
): Promise<Result<BudgetDetail>> {
  const head = await one(
    db
      .from("budgets")
      .select("id, project_id")
      .eq("id", budgetId)
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .maybeSingle(),
    (r) => r,
  );
  if (!head.ok) return head;
  const [summaries, lines, amounts] = await Promise.all([
    listBudgets(db, { orgId, projectId: str(head.data["project_id"]) }),
    rows(
      db
        .from("budget_lines")
        .select(LINE_COLUMNS)
        .eq("budget_id", budgetId)
        .is("deleted_at", null)
        .order("line_number"),
      (r) => r,
    ),
    rows(db.from("budget_line_amounts").select("*").eq("budget_id", budgetId), (r) => r),
  ]);
  if (!summaries.ok) return summaries;
  if (!lines.ok) return lines;
  if (!amounts.ok) return amounts;
  const budget = summaries.data.find((b) => b.id === budgetId);
  if (!budget) return fail({ kind: "not-found" });
  const byLine = new Map(amounts.data.map((a) => [str(a["budget_line_id"]), a]));
  return ok({ budget, lines: lines.data.map((l) => toLine(l, byLine.get(str(l["id"])))) });
}

export interface BudgetInput {
  readonly projectId: string;
  readonly name: string;
  readonly currency: string;
  readonly isBaseline: boolean;
}

/** Creates a budget. Needs finance.budget.write on the project; one baseline per project. */
export async function createBudget(
  db: XosClient,
  orgId: string,
  input: BudgetInput,
): Promise<Result<{ id: string }>> {
  return one(
    db
      .from("budgets")
      .insert({
        org_id: orgId,
        project_id: input.projectId,
        name: input.name.trim(),
        currency_code: input.currency,
        is_baseline: input.isBaseline,
      })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function updateBudget(
  db: XosClient,
  budgetId: string,
  input: { readonly name: string; readonly isBaseline: boolean },
): Promise<Result<null>> {
  return done(
    db
      .from("budgets")
      .update({ name: input.name.trim(), is_baseline: input.isBaseline })
      .eq("id", budgetId),
  );
}

export async function deleteBudget(db: XosClient, budgetId: string): Promise<Result<null>> {
  return done(db.from("budgets").update({ deleted_at: now() }).eq("id", budgetId));
}

export interface BudgetLineInput {
  readonly description: string;
  readonly lineType: BudgetLineType;
  readonly urid: string;
  readonly costCenterId: string | null;
  readonly gradeCode: string | null;
  readonly elementId: string | null;
  readonly quantity: number;
  readonly unitBasis: string | null;
  /** Minor units; null is unpriced and is stored as NULL. */
  readonly unitPriceMinor: number | null;
  readonly xyz: XyzTag;
  readonly xyzBasis: "Category" | "Declared";
}

/**
 * The XYZ tag and basis for a URID: a category's own tag with basis Category, or the declared tag
 * for a discipline or when the person overrides it. Null when a discipline has no declared tag.
 */
export function xyzFor(
  urid: string,
  options: readonly UridOption[],
  declared: XyzTag | null,
): { xyz: XyzTag; xyzBasis: "Category" | "Declared" } | null {
  const option = options.find((o) => o.urid === urid);
  if (option?.xyz && (declared === null || declared === option.xyz))
    return { xyz: option.xyz, xyzBasis: "Category" };
  return declared ? { xyz: declared, xyzBasis: "Declared" } : null;
}

const lineRow = (input: BudgetLineInput) => ({
  description: input.description.trim(),
  line_type: input.lineType,
  urid: input.urid,
  cost_center_id: input.costCenterId,
  grade_code: input.gradeCode,
  element_id: input.elementId,
  quantity: input.quantity,
  unit_basis: input.unitBasis,
  unit_price_minor: input.unitPriceMinor,
  xyz: input.xyz,
  xyz_basis: input.xyzBasis,
});

/**
 * Appends lines to a budget in one insert, numbered after the last live line. Used by single adds,
 * catalog picks and spreadsheet pastes; returns the new ids so a paste can be undone as a batch.
 */
export async function addBudgetLines(
  db: XosClient,
  orgId: string,
  budgetId: string,
  inputs: readonly BudgetLineInput[],
): Promise<Result<{ ids: string[] }>> {
  if (inputs.length === 0) return ok({ ids: [] });
  const last = await rows(
    db
      .from("budget_lines")
      .select("line_number")
      .eq("budget_id", budgetId)
      .is("deleted_at", null)
      .order("line_number", { ascending: false })
      .limit(1),
    (r) => num(r["line_number"]),
  );
  if (!last.ok) return last;
  const start = (last.data[0] ?? 0) + 1;
  const result = await rows(
    db
      .from("budget_lines")
      .insert(
        inputs.map((input, i) => ({
          ...lineRow(input),
          org_id: orgId,
          budget_id: budgetId,
          line_number: start + i,
        })),
      )
      .select("id"),
    (r) => str(r["id"]),
  );
  return result.ok ? ok({ ids: result.data }) : result;
}

export interface LineConflict {
  readonly kind: "line-conflict";
  /** The line as saved by someone else since the person read it. */
  readonly current: BudgetLine;
}

/**
 * Saves a budget line only if nobody changed it since `expectedUpdatedAt` (Section 11.7: a later save
 * is checked against the version it started from). On a conflict, returns the current line so the
 * page can show both values and let the person choose; nothing is silently overwritten.
 */
export async function updateBudgetLine(
  db: XosClient,
  lineId: string,
  expectedUpdatedAt: string,
  input: BudgetLineInput,
): Promise<Result<BudgetLine> | { ok: false; error: LineConflict }> {
  const { data, error } = await db
    .from("budget_lines")
    .update(lineRow(input))
    .eq("id", lineId)
    .eq("updated_at", expectedUpdatedAt)
    .select(LINE_COLUMNS);
  if (error) return fail(toDataError(error));
  const saved = (data as Raw[] | null)?.[0];
  if (saved) return ok(toLine(saved));
  const current = await one(
    db
      .from("budget_lines")
      .select(LINE_COLUMNS)
      .eq("id", lineId)
      .is("deleted_at", null)
      .maybeSingle(),
    (r) => toLine(r),
  );
  if (!current.ok) return current;
  return { ok: false, error: { kind: "line-conflict", current: current.data } };
}

/** Soft deletes lines, for removing lines and undoing a paste. */
export async function deleteBudgetLines(
  db: XosClient,
  lineIds: readonly string[],
): Promise<Result<null>> {
  if (lineIds.length === 0) return ok(null);
  return done(
    db
      .from("budget_lines")
      .update({ deleted_at: now() })
      .in("id", [...lineIds]),
  );
}

/** Restores soft-deleted lines, for undoing a delete within the Undo window. */
export async function restoreBudgetLines(
  db: XosClient,
  lineIds: readonly string[],
): Promise<Result<null>> {
  if (lineIds.length === 0) return ok(null);
  return done(
    db
      .from("budget_lines")
      .update({ deleted_at: null })
      .in("id", [...lineIds]),
  );
}

/** Draws contingency onto another line of the same budget; the database refuses overdraws. */
export async function drawContingency(
  db: XosClient,
  orgId: string,
  input: {
    readonly fromLineId: string;
    readonly toLineId: string;
    readonly amountMinor: number;
    readonly reason: string;
  },
): Promise<Result<null>> {
  return done(
    db.from("contingency_draws").insert({
      org_id: orgId,
      from_budget_line_id: input.fromLineId,
      to_budget_line_id: input.toLineId,
      amount_minor: input.amountMinor,
      reason: input.reason.trim(),
    }),
  );
}

/** Budget lines the viewer may post expenses or change orders to, with their budget and project. */
export interface BudgetLineRef {
  readonly id: string;
  readonly budgetId: string;
  readonly budgetName: string;
  readonly projectId: string;
  readonly currency: string;
  readonly lineNumber: number;
  readonly description: string;
  readonly urid: string;
  readonly lineType: BudgetLineType;
}

export async function listBudgetLineRefs(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<BudgetLineRef[]>> {
  let query = db
    .from("budget_lines")
    .select(
      "id, budget_id, line_number, description, urid, line_type, budget:budgets!inner(name, project_id, currency_code, deleted_at)",
    )
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .is("budget.deleted_at", null)
    .order("line_number");
  if (input.projectId) query = query.eq("budget.project_id", input.projectId);
  return rows(query, (r) => {
    const b = obj(r["budget"]);
    return {
      id: str(r["id"]),
      budgetId: str(r["budget_id"]),
      budgetName: str(b?.["name"]),
      projectId: str(b?.["project_id"]),
      currency: str(b?.["currency_code"]).trim(),
      lineNumber: num(r["line_number"]),
      description: str(r["description"]),
      urid: str(r["urid"]),
      lineType: str(r["line_type"]) as BudgetLineType,
    };
  });
}

// Expenses ---------------------------------------------------------------------------------------------

export interface Expense {
  readonly id: string;
  readonly budgetLineId: string;
  readonly lineDescription: string | null;
  readonly budgetId: string | null;
  readonly projectId: string | null;
  readonly counterpartyId: string | null;
  readonly submitterPersonId: string | null;
  readonly description: string;
  readonly incurredOn: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly state: ExpenseState;
  readonly createdAt: string;
}

const EXPENSE_COLUMNS =
  "id, budget_line_id, counterparty_id, submitter_person_id, description, incurred_on, amount_minor, currency_code, expense_state, created_at, line:budget_lines(description, budget_id, budget:budgets(project_id))";

function toExpense(r: Raw): Expense {
  const line = obj(r["line"]);
  const budget = obj(line?.["budget"]);
  return {
    id: str(r["id"]),
    budgetLineId: str(r["budget_line_id"]),
    lineDescription: strOrNull(line?.["description"]),
    budgetId: strOrNull(line?.["budget_id"]),
    projectId: strOrNull(budget?.["project_id"]),
    counterpartyId: strOrNull(r["counterparty_id"]),
    submitterPersonId: strOrNull(r["submitter_person_id"]),
    description: str(r["description"]),
    incurredOn: str(r["incurred_on"]),
    amountMinor: num(r["amount_minor"]),
    currency: str(r["currency_code"]).trim(),
    state: str(r["expense_state"]) as ExpenseState,
    createdAt: str(r["created_at"]),
  };
}

/** Expenses the viewer may read, newest first, optionally for one project. */
export async function listExpenses(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<Expense[]>> {
  const result = await rows(
    db
      .from("expenses")
      .select(EXPENSE_COLUMNS)
      .eq("org_id", input.orgId)
      .is("deleted_at", null)
      .order("incurred_on", { ascending: false }),
    toExpense,
  );
  if (!result.ok || !input.projectId) return result;
  return ok(result.data.filter((e) => e.projectId === input.projectId));
}

export interface ExpenseInput {
  readonly budgetLineId: string;
  readonly counterpartyId: string | null;
  readonly description: string;
  readonly incurredOn: string;
  readonly amountMinor: number;
  readonly currency: string;
}

/** Submits an expense against exactly one budget line (invariant 12); the submitter is the session. */
export async function createExpense(
  db: XosClient,
  orgId: string,
  input: ExpenseInput,
): Promise<Result<{ id: string }>> {
  return one(
    db
      .from("expenses")
      .insert({
        org_id: orgId,
        budget_line_id: input.budgetLineId,
        counterparty_id: input.counterpartyId,
        description: input.description.trim(),
        incurred_on: input.incurredOn,
        amount_minor: input.amountMinor,
        currency_code: input.currency,
      })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

/** Edits a Proposed expense; the database refuses amount and date changes after submission review. */
export async function updateExpense(
  db: XosClient,
  expenseId: string,
  input: Omit<ExpenseInput, "budgetLineId">,
): Promise<Result<null>> {
  return done(
    db
      .from("expenses")
      .update({
        counterparty_id: input.counterpartyId,
        description: input.description.trim(),
        incurred_on: input.incurredOn,
        amount_minor: input.amountMinor,
        currency_code: input.currency,
      })
      .eq("id", expenseId),
  );
}

/**
 * The outcome of an approval under spend authority: `complete` is false when the approval was
 * recorded but the amount is above the dual threshold and still needs a second approver (Section 8.1).
 */
export interface ApprovalOutcome {
  readonly complete: boolean;
}

export async function approveExpense(
  db: XosClient,
  expenseId: string,
  reason: string,
): Promise<Result<ApprovalOutcome>> {
  const result = await rpcValue<boolean>(
    db.rpc("approve_expense", { p_expense_id: expenseId, p_reason: reason }),
  );
  return result.ok ? ok({ complete: result.data === true }) : result;
}

export async function rejectExpense(
  db: XosClient,
  expenseId: string,
  reason: string,
): Promise<Result<null>> {
  const r = await rpcValue(db.rpc("reject_expense", { p_expense_id: expenseId, p_reason: reason }));
  return r.ok ? ok(null) : r;
}

/** Cancels, resubmits or marks Paid, with compare-and-set on the expected state. */
export async function transitionExpense(
  db: XosClient,
  input: {
    readonly id: string;
    readonly expected: ExpenseState;
    readonly next: ExpenseState;
    readonly reason: string;
  },
): Promise<Result<null>> {
  const r = await rpcValue(
    db.rpc("transition_expense", {
      p_expense_id: input.id,
      p_expected: input.expected,
      p_next: input.next,
      p_reason: input.reason,
    }),
  );
  return r.ok ? ok(null) : r;
}

// Change orders ----------------------------------------------------------------------------------------

export interface ChangeOrder {
  readonly id: string;
  readonly projectId: string;
  readonly budgetId: string;
  readonly number: number;
  readonly title: string;
  readonly orderTypeId: string | null;
  readonly reason: string | null;
  readonly requestedBy: string | null;
  readonly pricedBy: string | null;
  readonly state: ChangeOrderState;
  readonly lineCount: number;
  readonly unpricedCount: number;
  readonly totalMinor: number | null;
  readonly createdAt: string;
}

export interface ChangeOrderLine {
  readonly id: string;
  readonly budgetLineId: string | null;
  readonly description: string;
  readonly urid: string;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly isNoCost: boolean;
  readonly extendedMinor: number | null;
}

/** Change orders the viewer may read, newest first, with their NULL-aware totals. */
export async function listChangeOrders(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId?: string | null; readonly id?: string },
): Promise<Result<ChangeOrder[]>> {
  let query = db
    .from("change_orders")
    .select(
      "id, project_id, budget_id, change_order_number, title, order_type_enum_id, reason, requested_by, priced_by, change_order_state, created_at",
    )
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (input.projectId) query = query.eq("project_id", input.projectId);
  if (input.id) query = query.eq("id", input.id);
  const orders = await rows(query, (r) => r);
  if (!orders.ok) return orders;
  if (orders.data.length === 0) return ok([]);
  const totals = await rows(
    db
      .from("change_order_totals")
      .select("change_order_id, line_count, unpriced_count, total_minor")
      .in(
        "change_order_id",
        orders.data.map((o) => str(o["id"])),
      ),
    (r) => r,
  );
  if (!totals.ok) return totals;
  const byId = new Map(totals.data.map((t) => [str(t["change_order_id"]), t]));
  return ok(
    orders.data.map((o) => {
      const t = byId.get(str(o["id"])) ?? {};
      return {
        id: str(o["id"]),
        projectId: str(o["project_id"]),
        budgetId: str(o["budget_id"]),
        number: num(o["change_order_number"]),
        title: str(o["title"]),
        orderTypeId: strOrNull(o["order_type_enum_id"]),
        reason: strOrNull(o["reason"]),
        requestedBy: strOrNull(o["requested_by"]),
        pricedBy: strOrNull(o["priced_by"]),
        state: str(o["change_order_state"]) as ChangeOrderState,
        lineCount: num(t["line_count"]),
        unpricedCount: num(t["unpriced_count"]),
        totalMinor: numOrNull(t["total_minor"]),
        createdAt: str(o["created_at"]),
      };
    }),
  );
}

/** The lines of a change order in creation order. */
export async function listChangeOrderLines(
  db: XosClient,
  changeOrderId: string,
): Promise<Result<ChangeOrderLine[]>> {
  return rows(
    db
      .from("change_order_lines")
      .select("id, budget_line_id, description, urid, quantity, unit_price_minor, is_no_cost")
      .eq("change_order_id", changeOrderId)
      .is("deleted_at", null)
      .order("created_at"),
    (r) => {
      const quantity = num(r["quantity"]);
      const price = numOrNull(r["unit_price_minor"]);
      return {
        id: str(r["id"]),
        budgetLineId: strOrNull(r["budget_line_id"]),
        description: str(r["description"]),
        urid: str(r["urid"]),
        quantity,
        unitPriceMinor: price,
        isNoCost: r["is_no_cost"] === true,
        extendedMinor: extendedMinor(quantity, price),
      };
    },
  );
}

export interface ChangeOrderInput {
  readonly projectId: string;
  readonly budgetId: string;
  readonly title: string;
  readonly orderTypeId: string | null;
  readonly reason: string | null;
}

/** Requests a change order against a budget of its project; the requester is the session person. */
export async function createChangeOrder(
  db: XosClient,
  orgId: string,
  input: ChangeOrderInput,
): Promise<Result<{ id: string }>> {
  return one(
    db
      .from("change_orders")
      .insert({
        org_id: orgId,
        project_id: input.projectId,
        budget_id: input.budgetId,
        title: input.title.trim(),
        order_type_enum_id: input.orderTypeId,
        reason: input.reason?.trim() || null,
      })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function updateChangeOrder(
  db: XosClient,
  id: string,
  input: Pick<ChangeOrderInput, "title" | "orderTypeId" | "reason">,
): Promise<Result<null>> {
  return done(
    db
      .from("change_orders")
      .update({
        title: input.title.trim(),
        order_type_enum_id: input.orderTypeId,
        reason: input.reason?.trim() || null,
      })
      .eq("id", id),
  );
}

export interface ChangeOrderLineInput {
  readonly budgetLineId: string | null;
  readonly description: string;
  readonly urid: string;
  readonly quantity: number;
  /** Null is unpriced. Zero is stored only with `isNoCost` (invariant 11). */
  readonly unitPriceMinor: number | null;
  readonly isNoCost: boolean;
}

const coLineRow = (input: ChangeOrderLineInput) => ({
  budget_line_id: input.budgetLineId,
  description: input.description.trim(),
  urid: input.urid,
  quantity: input.quantity,
  unit_price_minor: input.isNoCost ? 0 : input.unitPriceMinor,
  is_no_cost: input.isNoCost,
});

export async function addChangeOrderLine(
  db: XosClient,
  orgId: string,
  changeOrderId: string,
  input: ChangeOrderLineInput,
): Promise<Result<null>> {
  return done(
    db
      .from("change_order_lines")
      .insert({ ...coLineRow(input), org_id: orgId, change_order_id: changeOrderId }),
  );
}

export async function updateChangeOrderLine(
  db: XosClient,
  lineId: string,
  input: ChangeOrderLineInput,
): Promise<Result<null>> {
  return done(db.from("change_order_lines").update(coLineRow(input)).eq("id", lineId));
}

export async function deleteChangeOrderLine(db: XosClient, lineId: string): Promise<Result<null>> {
  return done(db.from("change_order_lines").update({ deleted_at: now() }).eq("id", lineId));
}

export async function priceChangeOrder(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<null>> {
  const r = await rpcValue(
    db.rpc("price_change_order", { p_change_order_id: id, p_reason: reason }),
  );
  return r.ok ? ok(null) : r;
}

export async function approveChangeOrder(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<ApprovalOutcome>> {
  const r = await rpcValue<boolean>(
    db.rpc("approve_change_order", { p_change_order_id: id, p_reason: reason }),
  );
  return r.ok ? ok({ complete: r.data === true }) : r;
}

/** Reworks, rejects or cancels a change order with compare-and-set. */
export async function transitionChangeOrder(
  db: XosClient,
  input: {
    readonly id: string;
    readonly expected: ChangeOrderState;
    readonly next: ChangeOrderState;
    readonly reason: string;
  },
): Promise<Result<null>> {
  const r = await rpcValue(
    db.rpc("transition_change_order", {
      p_change_order_id: input.id,
      p_expected: input.expected,
      p_next: input.next,
      p_reason: input.reason,
    }),
  );
  return r.ok ? ok(null) : r;
}

// Invoices ---------------------------------------------------------------------------------------------

export interface Invoice {
  readonly id: string;
  readonly projectId: string;
  readonly direction: MoneyDirection;
  /** The external account billed or billing; null when a person engaged as an individual is the payee. */
  readonly counterpartyId: string | null;
  /** The person billing as an individual (A38-007); exactly one of counterpartyId and payeePersonId is set. */
  readonly payeePersonId: string | null;
  readonly payeeName: string | null;
  readonly engagementId: string | null;
  readonly number: string | null;
  readonly issuedOn: string | null;
  readonly dueOn: string | null;
  readonly currency: string;
  readonly state: InvoiceState;
  readonly unpricedCount: number;
  readonly subtotalMinor: number | null;
  readonly taxMinor: number | null;
  readonly totalMinor: number | null;
  readonly appliedMinor: number;
  readonly createdAt: string;
}

export interface InvoiceLine {
  readonly id: string;
  readonly lineNumber: number;
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly budgetLineId: string | null;
  readonly extendedMinor: number | null;
}

/** Invoices the viewer may read, newest first, with NULL-aware totals and the amount applied. */
export async function listInvoices(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId?: string | null; readonly id?: string },
): Promise<Result<Invoice[]>> {
  let query = db
    .from("invoices")
    .select(
      "id, project_id, direction, counterparty_id, payee_person_id, engagement_id, invoice_number, issued_on, due_on, currency_code, invoice_state, created_at, payee:people!invoices_payee_person_id_fkey(full_name)",
    )
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (input.projectId) query = query.eq("project_id", input.projectId);
  if (input.id) query = query.eq("id", input.id);
  const invoices = await rows(query, (r) => r);
  if (!invoices.ok) return invoices;
  if (invoices.data.length === 0) return ok([]);
  const totals = await rows(
    db
      .from("invoice_totals")
      .select("invoice_id, unpriced_count, subtotal_minor, tax_minor, applied_minor")
      .in(
        "invoice_id",
        invoices.data.map((i) => str(i["id"])),
      ),
    (r) => r,
  );
  if (!totals.ok) return totals;
  const byId = new Map(totals.data.map((t) => [str(t["invoice_id"]), t]));
  // The individual payee's name through the one name resolution (A59-011), never "Individual".
  const named = await fillPersonNames(
    db,
    invoices.data,
    (i) => strOrNull(i["payee_person_id"]),
    (i) => strOrNull(obj(i["payee"])?.["full_name"]),
    (i, full_name) => ({ ...i, payee: { full_name } }),
  );
  return ok(
    named.map((i) => {
      const t = byId.get(str(i["id"])) ?? {};
      const subtotal = numOrNull(t["subtotal_minor"]);
      const tax = numOrNull(t["tax_minor"]);
      return {
        id: str(i["id"]),
        projectId: str(i["project_id"]),
        direction: str(i["direction"]) as MoneyDirection,
        counterpartyId: strOrNull(i["counterparty_id"]),
        payeePersonId: strOrNull(i["payee_person_id"]),
        payeeName: strOrNull(obj(i["payee"])?.["full_name"]),
        engagementId: strOrNull(i["engagement_id"]),
        number: strOrNull(i["invoice_number"]),
        issuedOn: strOrNull(i["issued_on"]),
        dueOn: strOrNull(i["due_on"]),
        currency: str(i["currency_code"]).trim(),
        state: str(i["invoice_state"]) as InvoiceState,
        unpricedCount: num(t["unpriced_count"]),
        subtotalMinor: subtotal,
        taxMinor: tax,
        totalMinor: subtotal === null || tax === null ? null : subtotal + tax,
        appliedMinor: num(t["applied_minor"]),
        createdAt: str(i["created_at"]),
      };
    }),
  );
}

export async function listInvoiceLines(
  db: XosClient,
  invoiceId: string,
): Promise<Result<InvoiceLine[]>> {
  return rows(
    db
      .from("invoice_lines")
      .select("id, line_number, description, quantity, unit_price_minor, budget_line_id")
      .eq("invoice_id", invoiceId)
      .is("deleted_at", null)
      .order("line_number"),
    (r) => {
      const quantity = num(r["quantity"]);
      const price = numOrNull(r["unit_price_minor"]);
      return {
        id: str(r["id"]),
        lineNumber: num(r["line_number"]),
        description: str(r["description"]),
        quantity,
        unitPriceMinor: price,
        budgetLineId: strOrNull(r["budget_line_id"]),
        extendedMinor: extendedMinor(quantity, price),
      };
    },
  );
}

export interface InvoiceInput {
  readonly projectId: string;
  readonly direction: MoneyDirection;
  readonly counterpartyId: string;
  readonly number: string | null;
  readonly issuedOn: string | null;
  readonly dueOn: string | null;
  readonly currency: string;
}

export async function createInvoice(
  db: XosClient,
  orgId: string,
  input: InvoiceInput,
): Promise<Result<{ id: string }>> {
  return one(
    db
      .from("invoices")
      .insert({
        org_id: orgId,
        project_id: input.projectId,
        direction: input.direction,
        counterparty_id: input.counterpartyId,
        invoice_number: input.number?.trim() || null,
        issued_on: input.issuedOn,
        due_on: input.dueOn,
        currency_code: input.currency,
      })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function updateInvoice(
  db: XosClient,
  id: string,
  input: Pick<InvoiceInput, "number" | "issuedOn" | "dueOn">,
): Promise<Result<null>> {
  return done(
    db
      .from("invoices")
      .update({
        invoice_number: input.number?.trim() || null,
        issued_on: input.issuedOn,
        due_on: input.dueOn,
      })
      .eq("id", id),
  );
}

export interface InvoiceLineInput {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly budgetLineId: string | null;
}

export async function addInvoiceLine(
  db: XosClient,
  orgId: string,
  invoiceId: string,
  input: InvoiceLineInput,
): Promise<Result<null>> {
  const last = await rows(
    db
      .from("invoice_lines")
      .select("line_number")
      .eq("invoice_id", invoiceId)
      .is("deleted_at", null)
      .order("line_number", { ascending: false })
      .limit(1),
    (r) => num(r["line_number"]),
  );
  if (!last.ok) return last;
  return done(
    db.from("invoice_lines").insert({
      org_id: orgId,
      invoice_id: invoiceId,
      line_number: (last.data[0] ?? 0) + 1,
      description: input.description.trim(),
      quantity: input.quantity,
      unit_price_minor: input.unitPriceMinor,
      budget_line_id: input.budgetLineId,
    }),
  );
}

export async function deleteInvoiceLine(db: XosClient, lineId: string): Promise<Result<null>> {
  return done(db.from("invoice_lines").update({ deleted_at: now() }).eq("id", lineId));
}

export async function issueInvoice(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<null>> {
  const r = await rpcValue(db.rpc("issue_invoice", { p_invoice_id: id, p_reason: reason }));
  return r.ok ? ok(null) : r;
}

export async function approveInvoice(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<ApprovalOutcome>> {
  const r = await rpcValue<boolean>(
    db.rpc("approve_invoice", { p_invoice_id: id, p_reason: reason }),
  );
  return r.ok ? ok({ complete: r.data === true }) : r;
}

export async function transitionInvoice(
  db: XosClient,
  input: {
    readonly id: string;
    readonly expected: InvoiceState;
    readonly next: InvoiceState;
    readonly reason: string;
  },
): Promise<Result<null>> {
  const r = await rpcValue(
    db.rpc("transition_invoice", {
      p_invoice_id: input.id,
      p_expected: input.expected,
      p_next: input.next,
      p_reason: input.reason,
    }),
  );
  return r.ok ? ok(null) : r;
}

// Payments ---------------------------------------------------------------------------------------------

export interface Payment {
  readonly id: string;
  /** Counterparty paid or paying; null for a payment to a person engaged as an individual. */
  readonly counterpartyId: string | null;
  readonly payeePersonId: string | null;
  readonly payeeName: string | null;
  readonly direction: MoneyDirection;
  readonly amountMinor: number;
  readonly currency: string;
  readonly paidOn: string;
  readonly reference: string | null;
  readonly state: PaymentState;
  readonly appliedMinor: number;
  readonly createdAt: string;
}

export interface PaymentApplication {
  readonly id: string;
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly amountMinor: number;
}

/** Payments of the org, newest first, with the amount applied to invoices. */
export async function listPayments(db: XosClient, orgId: string): Promise<Result<Payment[]>> {
  const result = await rows(
    db
      .from("payments")
      .select(
        "id, counterparty_id, payee_person_id, direction, amount_minor, currency_code, paid_on, reference_identifier, payment_state, created_at, payment_applications(amount_minor, deleted_at), payee:people!payments_payee_person_id_fkey(full_name)",
      )
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("paid_on", { ascending: false }),
    (r) => {
      const apps = (r["payment_applications"] as Raw[] | null) ?? [];
      return {
        id: str(r["id"]),
        counterpartyId: strOrNull(r["counterparty_id"]),
        payeePersonId: strOrNull(r["payee_person_id"]),
        payeeName: strOrNull(obj(r["payee"])?.["full_name"]),
        direction: str(r["direction"]) as MoneyDirection,
        amountMinor: num(r["amount_minor"]),
        currency: str(r["currency_code"]).trim(),
        paidOn: str(r["paid_on"]),
        reference: strOrNull(r["reference_identifier"]),
        state: str(r["payment_state"]) as PaymentState,
        appliedMinor: apps
          .filter((a) => a["deleted_at"] === null || a["deleted_at"] === undefined)
          .reduce((sum, a) => sum + num(a["amount_minor"]), 0),
        createdAt: str(r["created_at"]),
      };
    },
  );
  if (!result.ok) return result;
  return ok(
    await fillPersonNames(
      db,
      result.data,
      (p) => p.payeePersonId,
      (p) => p.payeeName,
      (p, payeeName) => ({ ...p, payeeName }),
    ),
  );
}

export async function listPaymentApplications(
  db: XosClient,
  paymentId: string,
): Promise<Result<PaymentApplication[]>> {
  return rows(
    db
      .from("payment_applications")
      .select("id, payment_id, invoice_id, amount_minor")
      .eq("payment_id", paymentId)
      .is("deleted_at", null)
      .order("created_at"),
    (r) => ({
      id: str(r["id"]),
      paymentId: str(r["payment_id"]),
      invoiceId: str(r["invoice_id"]),
      amountMinor: num(r["amount_minor"]),
    }),
  );
}

export interface PaymentInput {
  readonly counterpartyId: string;
  readonly direction: MoneyDirection;
  readonly amountMinor: number;
  readonly currency: string;
  readonly paidOn: string;
  readonly reference: string | null;
}

export async function createPayment(
  db: XosClient,
  orgId: string,
  input: PaymentInput,
): Promise<Result<{ id: string }>> {
  return one(
    db
      .from("payments")
      .insert({
        org_id: orgId,
        counterparty_id: input.counterpartyId,
        direction: input.direction,
        amount_minor: input.amountMinor,
        currency_code: input.currency,
        paid_on: input.paidOn,
        reference_identifier: input.reference?.trim() || null,
      })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

export async function approvePayment(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<null>> {
  const r = await rpcValue(db.rpc("approve_payment", { p_payment_id: id, p_reason: reason }));
  return r.ok ? ok(null) : r;
}

export async function cancelPayment(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<null>> {
  const r = await rpcValue(db.rpc("cancel_payment", { p_payment_id: id, p_reason: reason }));
  return r.ok ? ok(null) : r;
}

/** Applies part of a payment to an invoice; the database refuses over-application (invariant 16). */
export async function applyPayment(
  db: XosClient,
  orgId: string,
  input: { readonly paymentId: string; readonly invoiceId: string; readonly amountMinor: number },
): Promise<Result<null>> {
  return done(
    db.from("payment_applications").insert({
      org_id: orgId,
      payment_id: input.paymentId,
      invoice_id: input.invoiceId,
      amount_minor: input.amountMinor,
    }),
  );
}

export async function removePaymentApplication(
  db: XosClient,
  applicationId: string,
): Promise<Result<null>> {
  return done(
    db.from("payment_applications").update({ deleted_at: now() }).eq("id", applicationId),
  );
}

/**
 * Records that an approved payable (or issued receivable) was paid: a Proposed payment of the
 * invoice's payee (its counterparty, or the person engaged as an individual), applied to the
 * invoice, for the whole balance when no amount is given (app.record_invoice_payment, 1123). Another
 * eligible person approves it with approvePayment.
 */
export async function recordInvoicePayment(
  db: XosClient,
  input: {
    readonly invoiceId: string;
    readonly amountMinor: number | null;
    readonly paidOn: string;
    readonly reference: string | null;
  },
): Promise<Result<{ id: string }>> {
  const r = await rpcValue<string>(
    db.rpc("record_invoice_payment", {
      p_invoice_id: input.invoiceId,
      p_paid_on: input.paidOn,
      ...(input.amountMinor === null ? {} : { p_amount_minor: input.amountMinor }),
      ...(input.reference?.trim() ? { p_reference: input.reference.trim() } : {}),
    }),
  );
  return r.ok ? ok({ id: r.data }) : r;
}

/**
 * The port a payout provider plugs into (Section 4.4.5): XOS never holds funds, and executing a
 * payout is the org's decision on its own rails or provider. A provider moves the money and returns
 * its remittance reference, which is recorded with recordInvoicePayment. The only provider shipped
 * is ManualPayout: the org pays outside XOS and types the reference it got from its bank.
 */
export interface PayoutProvider {
  readonly name: string;
  /**
   * Moves `amountMinor` (the invoice's whole balance when null) to the payee and answers the
   * provider's reference for the remittance.
   */
  pay(request: {
    readonly invoiceId: string;
    readonly amountMinor: number | null;
    readonly currency: string;
  }): Promise<{ readonly reference: string | null }>;
}

/** Payouts made outside XOS: nothing moves here, the reference is the one the org entered. */
export function manualPayout(reference: string | null): PayoutProvider {
  return {
    name: "manual",
    pay: async () => ({ reference: reference?.trim() || null }),
  };
}

/** Pays through `provider`, then records the payment against the invoice. */
export async function payInvoice(
  db: XosClient,
  provider: PayoutProvider,
  input: {
    readonly invoiceId: string;
    readonly amountMinor: number | null;
    readonly currency: string;
    readonly paidOn: string;
  },
): Promise<Result<{ id: string }>> {
  const payout = await provider.pay(input);
  return recordInvoicePayment(db, {
    invoiceId: input.invoiceId,
    amountMinor: input.amountMinor,
    paidOn: input.paidOn,
    reference: payout.reference,
  });
}

// Accounting periods -----------------------------------------------------------------------------------

export interface AccountingPeriod {
  readonly id: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly state: PeriodState;
  readonly createdAt: string;
}

/** Accounting periods of the org, latest first. */
export async function listPeriods(
  db: XosClient,
  orgId: string,
): Promise<Result<AccountingPeriod[]>> {
  return rows(
    db
      .from("accounting_periods")
      .select("id, starts_on, ends_on, period_state, created_at")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .order("starts_on", { ascending: false }),
    (r) => ({
      id: str(r["id"]),
      startsOn: str(r["starts_on"]),
      endsOn: str(r["ends_on"]),
      state: str(r["period_state"]) as PeriodState,
      createdAt: str(r["created_at"]),
    }),
  );
}

/** Opens a period. Periods never overlap; the database refuses an overlap. */
export async function createPeriod(
  db: XosClient,
  orgId: string,
  input: { readonly startsOn: string; readonly endsOn: string },
): Promise<Result<{ id: string }>> {
  return one(
    db
      .from("accounting_periods")
      .insert({ org_id: orgId, starts_on: input.startsOn, ends_on: input.endsOn })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
}

/** Moves a period along its lifecycle with compare-and-set (invariant 13). */
export async function transitionPeriod(
  db: XosClient,
  input: {
    readonly id: string;
    readonly expected: PeriodState;
    readonly next: PeriodState;
    readonly reason: string;
  },
): Promise<Result<null>> {
  const r = await rpcValue(
    db.rpc("transition_accounting_period", {
      p_accounting_period_id: input.id,
      p_expected: input.expected,
      p_next: input.next,
      p_reason: input.reason,
    }),
  );
  return r.ok ? ok(null) : r;
}

// Journal ----------------------------------------------------------------------------------------------

export interface JournalLine {
  readonly id: string;
  readonly lineNumber: number;
  readonly accountCode: string;
  readonly costCenterId: string | null;
  readonly urid: string | null;
  readonly counterpartyId: string | null;
  readonly description: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
  readonly currency: string;
}

export interface JournalEntry {
  readonly id: string;
  readonly periodId: string;
  readonly projectId: string | null;
  readonly entryDate: string;
  readonly memo: string;
  readonly state: JournalState;
  readonly preparedBy: string | null;
  readonly postedBy: string | null;
  readonly postedAt: string | null;
  readonly sourceTable: string | null;
  readonly sourceId: string | null;
  readonly lines: readonly JournalLine[];
  readonly debitMinor: number;
  readonly creditMinor: number;
  readonly currency: string | null;
}

/** Journal entries of the org, newest first, each with its live lines and balance. */
export async function listJournalEntries(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId?: string | null },
): Promise<Result<JournalEntry[]>> {
  let query = db
    .from("journal_entries")
    .select(
      "id, accounting_period_id, project_id, entry_date, memo, journal_state, prepared_by, posted_by, posted_at, source_table, source_id, journal_lines(id, line_number, account_code, cost_center_id, urid, counterparty_id, description, debit_minor, credit_minor, currency_code, deleted_at)",
    )
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .order("entry_date", { ascending: false });
  if (input.projectId) query = query.eq("project_id", input.projectId);
  return rows(query, (r) => {
    const lines = ((r["journal_lines"] as Raw[] | null) ?? [])
      .filter((l) => l["deleted_at"] === null || l["deleted_at"] === undefined)
      .map((l): JournalLine => ({
        id: str(l["id"]),
        lineNumber: num(l["line_number"]),
        accountCode: str(l["account_code"]),
        costCenterId: strOrNull(l["cost_center_id"]),
        urid: strOrNull(l["urid"]),
        counterpartyId: strOrNull(l["counterparty_id"]),
        description: str(l["description"]),
        debitMinor: num(l["debit_minor"]),
        creditMinor: num(l["credit_minor"]),
        currency: str(l["currency_code"]).trim(),
      }))
      .sort((a, b) => a.lineNumber - b.lineNumber);
    return {
      id: str(r["id"]),
      periodId: str(r["accounting_period_id"]),
      projectId: strOrNull(r["project_id"]),
      entryDate: str(r["entry_date"]),
      memo: str(r["memo"]),
      state: str(r["journal_state"]) as JournalState,
      preparedBy: strOrNull(r["prepared_by"]),
      postedBy: strOrNull(r["posted_by"]),
      postedAt: strOrNull(r["posted_at"]),
      sourceTable: strOrNull(r["source_table"]),
      sourceId: strOrNull(r["source_id"]),
      lines,
      debitMinor: lines.reduce((s, l) => s + l.debitMinor, 0),
      creditMinor: lines.reduce((s, l) => s + l.creditMinor, 0),
      currency: lines[0]?.currency ?? null,
    };
  });
}

export interface JournalLineInput {
  readonly accountCode: string;
  readonly costCenterId: string | null;
  readonly urid: string | null;
  readonly description: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
}

export interface JournalEntryInput {
  readonly periodId: string;
  readonly projectId: string | null;
  readonly entryDate: string;
  readonly memo: string;
  readonly currency: string;
  readonly lines: readonly JournalLineInput[];
}

/**
 * Prepares a journal entry with its lines. The preparer is the session person, and a different
 * person posts it (Section 8.2). A period that refuses postings refuses the entry (invariant 13);
 * when the lines fail, the prepared header is canceled so no empty entry is left behind.
 */
export async function createJournalEntry(
  db: XosClient,
  orgId: string,
  input: JournalEntryInput,
): Promise<Result<{ id: string }>> {
  const head = await one(
    db
      .from("journal_entries")
      .insert({
        org_id: orgId,
        accounting_period_id: input.periodId,
        project_id: input.projectId,
        entry_date: input.entryDate,
        memo: input.memo.trim(),
      })
      .select("id")
      .single(),
    (r) => ({ id: str(r["id"]) }),
  );
  if (!head.ok) return head;
  const lines = await done(
    db.from("journal_lines").insert(
      input.lines.map((l, i) => ({
        org_id: orgId,
        journal_entry_id: head.data.id,
        line_number: i + 1,
        account_code: l.accountCode,
        cost_center_id: l.costCenterId,
        urid: l.urid,
        description: l.description.trim(),
        debit_minor: l.debitMinor,
        credit_minor: l.creditMinor,
        currency_code: input.currency,
      })),
    ),
  );
  if (!lines.ok) {
    const undo = await cancelJournalEntry(db, head.data.id, "Lines were refused.");
    if (!undo.ok) return undo;
    return lines;
  }
  return head;
}

export async function postJournalEntry(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<null>> {
  const r = await rpcValue(
    db.rpc("post_journal_entry", { p_journal_entry_id: id, p_reason: reason }),
  );
  return r.ok ? ok(null) : r;
}

export async function cancelJournalEntry(
  db: XosClient,
  id: string,
  reason: string,
): Promise<Result<null>> {
  const r = await rpcValue(
    db.rpc("cancel_journal_entry", { p_journal_entry_id: id, p_reason: reason }),
  );
  return r.ok ? ok(null) : r;
}

// Universal Posting Line (Section 3.11, Bible tab 36) ------------------------------------------------------

/** The fourteen UPL fields in canon order (xpms.dim_upl_field ordinals 1 to 14). */
export const UPL_FIELDS = [
  "date",
  "account_code",
  "cost_center_id",
  "urid",
  "vendor_id",
  "item_id",
  "description",
  "quantity",
  "unit_basis",
  "amount",
  "tax_type",
  "currency",
  "external_ref",
  "line_state",
] as const;
export type UplField = (typeof UPL_FIELDS)[number];
export type UplRow = Readonly<Record<UplField, string>>;

export interface PostingLine {
  readonly id: string;
  readonly projectId: string | null;
  readonly date: string;
  readonly accountCode: string;
  readonly costCenterCode: string | null;
  readonly urid: string | null;
  readonly vendorId: string | null;
  readonly itemId: string | null;
  readonly description: string;
  readonly quantity: number | null;
  readonly unitBasis: string | null;
  readonly amountMinor: number;
  readonly taxType: string;
  readonly currency: string;
  readonly externalRef: string;
  readonly lineState: string;
}

/** Posted lines (app.posting_lines) in a date range, in date then account order. */
export async function listPostingLines(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly from: string;
    readonly to: string;
    readonly projectId?: string | null;
  },
): Promise<Result<PostingLine[]>> {
  let query = db
    .from("posting_lines")
    .select("*")
    .eq("org_id", input.orgId)
    .gte("date", input.from)
    .lte("date", input.to)
    .order("date")
    .order("account_code");
  if (input.projectId) query = query.eq("project_id", input.projectId);
  return rows(query, (r) => ({
    id: str(r["posting_line_id"]),
    projectId: strOrNull(r["project_id"]),
    date: str(r["date"]),
    accountCode: str(r["account_code"]),
    costCenterCode: strOrNull(r["cost_center_id"]),
    urid: strOrNull(r["urid"]),
    vendorId: strOrNull(r["vendor_id"]),
    itemId: strOrNull(r["item_id"]),
    description: str(r["description"]),
    quantity: numOrNull(r["quantity"]),
    unitBasis: strOrNull(r["unit_basis"]),
    amountMinor: num(r["amount_minor"]),
    taxType: str(r["tax_type"]),
    currency: str(r["currency"]).trim(),
    externalRef: str(r["external_ref"]),
    lineState: str(r["line_state"]),
  }));
}

/** A UPL row: every field as text, amounts signed in major units with the currency's exponent. */
export function toUplRow(line: PostingLine, exponent: number): UplRow {
  return {
    date: line.date,
    account_code: line.accountCode,
    cost_center_id: line.costCenterCode ?? "",
    urid: line.urid ?? "",
    vendor_id: line.vendorId ?? "",
    item_id: line.itemId ?? "",
    description: line.description,
    quantity: line.quantity === null ? "" : String(line.quantity),
    unit_basis: line.unitBasis ?? "",
    amount: (line.amountMinor / 10 ** exponent).toFixed(exponent),
    tax_type: line.taxType,
    currency: line.currency,
    external_ref: line.externalRef,
    line_state: line.lineState,
  };
}

export interface UplMapping {
  /** Canon target code: xero, quickbooks, netsuite or ramp. */
  readonly target: string;
  /** UPL field to the target's column name, from the canon rule text. */
  readonly columns: Readonly<Partial<Record<UplField, string>>>;
  readonly rule: string;
}

/**
 * Parses the canon mapping rules (xpms.dim_upl_field rows after the fourteen fields), for example
 * `account_code → AccountCode; cost_center_id → TrackingCategory1`. The canon text is the only
 * source of the four projections; nothing here names a target column.
 */
export function parseUplMappings(
  rows: readonly { readonly field: string; readonly rule: string }[],
): UplMapping[] {
  const fields = new Set<string>(UPL_FIELDS);
  return rows
    .filter((r) => !fields.has(r.field))
    .map((r) => {
      const columns: Partial<Record<UplField, string>> = {};
      for (const part of r.rule.split(";")) {
        const [from, to] = part.split("→").map((s) => s.trim());
        if (from && to && fields.has(from)) columns[from as UplField] = to;
      }
      return { target: r.field, columns, rule: r.rule };
    });
}

/** The canon UPL mapping rules, in canon order. */
export async function listUplMappings(db: XosClient): Promise<Result<UplMapping[]>> {
  const result = await rows(
    db.schema("xpms").from("dim_upl_field").select("field, rule, ordinal").order("ordinal"),
    (r) => ({ field: str(r["field"]), rule: str(r["rule"]) }),
  );
  return result.ok ? ok(parseUplMappings(result.data)) : result;
}

/**
 * Projects UPL rows to one target: every UPL field keeps its place, renamed where the canon mapping
 * names a target column. With no mapping the header is the UPL field names (the one export shape).
 */
export function projectUpl(
  rows: readonly UplRow[],
  mapping: UplMapping | null,
): { header: string[]; body: string[][] } {
  return {
    header: UPL_FIELDS.map((f) => mapping?.columns[f] ?? f),
    body: rows.map((r) => UPL_FIELDS.map((f) => r[f])),
  };
}

/**
 * RFC 4180 CSV with CRLF line endings; fields with commas, quotes or line breaks are quoted, and a
 * field a spreadsheet would run as a formula is neutralized (A69-005, `csvField`).
 */
export function toCsv(header: readonly string[], body: readonly (readonly string[])[]): string {
  return [header, ...body].map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}
