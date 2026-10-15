import type { XosClient } from "../client";
import { fail, ok, toDataError, type Result } from "../result";
import { byCode, landed, MEMBERSHIP_EMBED, toMemberRef, type MemberRef } from "./shared";

/**
 * Labor rate cards, their lines and the pay rate ledger (migration 0341). A line names a canon role,
 * worker classification, pay basis, arrangement and overtime rule; titles and multipliers are joined
 * from canon, never repeated. Rates are Restricted: they are read only through the masked views, which
 * return null with `masked` true unless the caller holds data.restricted.read.payroll (or, for a pay
 * rate, it is their own). A null rate on an unmasked line is unpriced, never zero (Section 3.7).
 */

export interface RateCard {
  readonly id: string;
  readonly name: string;
  readonly currencyCode: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly lineCount: number;
}

export interface RateCardLine {
  readonly id: string;
  readonly rateCardId: string;
  readonly roleCode: string;
  readonly workerClassification: string;
  readonly payBasis: string;
  readonly arrangement: string;
  readonly canonRateCardId: string | null;
  readonly overtimeRuleId: string;
  /** Minor units; null when masked or unpriced, told apart by `masked`. */
  readonly rateMinor: number | null;
  readonly masked: boolean;
}

/** Rate cards of the org, current first, then by name. */
export async function listRateCards(db: XosClient, orgId: string): Promise<Result<RateCard[]>> {
  const { data, error } = await db
    .from("rate_cards")
    .select(
      "id, name, currency_code, effective_from, effective_to, rate_card_lines(id, deleted_at)",
    )
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((c) => ({
        id: c.id,
        name: c.name,
        currencyCode: c.currency_code,
        effectiveFrom: c.effective_from,
        effectiveTo: c.effective_to,
        lineCount: (c.rate_card_lines ?? []).filter((l) => l.deleted_at === null).length,
      }))
      .sort(
        (a, b) =>
          Number(a.effectiveTo !== null) - Number(b.effectiveTo !== null) ||
          b.effectiveFrom.localeCompare(a.effectiveFrom) ||
          a.name.localeCompare(b.name),
      ),
  );
}

export interface RateCardInput {
  readonly name: string;
  readonly currencyCode: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export async function createRateCard(
  db: XosClient,
  orgId: string,
  input: RateCardInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("rate_cards")
    .insert({
      org_id: orgId,
      name: input.name.trim(),
      currency_code: input.currencyCode,
      effective_from: input.effectiveFrom,
      effective_to: input.effectiveTo,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Renames a card or changes its dates; the currency is fixed once lines carry rates in it. */
export async function updateRateCard(
  db: XosClient,
  id: string,
  input: Omit<RateCardInput, "currencyCode">,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("rate_cards")
    .update({
      name: input.name.trim(),
      effective_from: input.effectiveFrom,
      effective_to: input.effectiveTo,
    })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

export async function trashRateCard(db: XosClient, id: string, at: Date = new Date()) {
  const { data, error } = await db
    .from("rate_cards")
    .update({ deleted_at: at.toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

/** Lines of a rate card in role code order, rates masked for callers without payroll access. */
export async function listRateCardLines(
  db: XosClient,
  rateCardId: string,
): Promise<Result<RateCardLine[]>> {
  const { data, error } = await db
    .from("rate_card_lines_masked")
    .select(
      "id, rate_card_id, role_code, worker_classification, pay_basis, arrangement, canon_rate_card_id, overtime_rule_id, rate_minor, is_masked",
    )
    .eq("rate_card_id", rateCardId);
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((l) => ({
        id: l.id ?? "",
        rateCardId: l.rate_card_id ?? rateCardId,
        roleCode: l.role_code ?? "",
        workerClassification: l.worker_classification ?? "",
        payBasis: l.pay_basis ?? "",
        arrangement: l.arrangement ?? "",
        canonRateCardId: l.canon_rate_card_id,
        overtimeRuleId: l.overtime_rule_id ?? "",
        rateMinor: l.is_masked ? null : l.rate_minor,
        masked: l.is_masked ?? true,
      }))
      .sort(
        (a, b) =>
          byCode(a.roleCode, b.roleCode) ||
          a.workerClassification.localeCompare(b.workerClassification) ||
          a.payBasis.localeCompare(b.payBasis),
      ),
  );
}

export interface RateCardLineInput {
  readonly roleCode: string;
  readonly workerClassification: string;
  readonly payBasis: string;
  readonly arrangement: string;
  readonly overtimeRuleId: string;
  readonly canonRateCardId: string | null;
  /** Null leaves the line unpriced. */
  readonly rateMinor: number | null;
}

/** Adds a line. The database refuses a pay basis or arrangement the classification does not permit. */
export async function addRateCardLine(
  db: XosClient,
  orgId: string,
  rateCardId: string,
  input: RateCardLineInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("rate_card_lines")
    .insert({
      org_id: orgId,
      rate_card_id: rateCardId,
      role_code: input.roleCode,
      worker_classification: input.workerClassification,
      pay_basis: input.payBasis,
      arrangement: input.arrangement,
      overtime_rule_id: input.overtimeRuleId,
      canon_rate_card_id: input.canonRateCardId,
      rate_minor: input.rateMinor,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Sets a line's rate (null unprices it) or its overtime rule. */
export async function updateRateCardLine(
  db: XosClient,
  id: string,
  patch: { readonly rateMinor?: number | null; readonly overtimeRuleId?: string },
): Promise<Result<null>> {
  const update: { rate_minor?: number | null; overtime_rule_id?: string } = {};
  if (patch.rateMinor !== undefined) update.rate_minor = patch.rateMinor;
  if (patch.overtimeRuleId !== undefined) update.overtime_rule_id = patch.overtimeRuleId;
  const { data, error } = await db
    .from("rate_card_lines")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

export async function removeRateCardLine(db: XosClient, id: string, at: Date = new Date()) {
  const { data, error } = await db
    .from("rate_card_lines")
    .update({ deleted_at: at.toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

// Canon options for rate card lines ----------------------------------------------------------------------

export interface RateCanon {
  readonly classifications: readonly { code: string; label: string }[];
  /** Permitted pay basis and classification pairs (decision D16). */
  readonly payBases: readonly { payBasis: string; classification: string }[];
  /** Permitted arrangement and classification pairs. */
  readonly arrangements: readonly { arrangement: string; classification: string }[];
  readonly overtimeRules: readonly {
    id: string;
    name: string;
    otMultiplier: number;
    dtMultiplier: number;
  }[];
  /** Canon Labor Rate Card entries a line can be adopted from. */
  readonly canonRateCards: readonly {
    id: string;
    roleCode: string;
    classification: string;
    payBasis: string;
    arrangement: string;
    overtimeRuleId: string;
    currencyCode: string;
  }[];
}

/** Canon lists for rate card lines, read from xpms, never retyped. */
export async function getRateCanon(db: XosClient): Promise<Result<RateCanon>> {
  const x = db.schema("xpms");
  const [classes, bases, arrangements, rules, cards] = await Promise.all([
    x.from("worker_classification").select("code, label, sort_order"),
    x.from("pay_basis_classification").select("pay_basis, worker_classification"),
    x.from("arrangement_classification").select("arrangement, worker_classification"),
    x.from("overtime_rule").select("rule_id, name, ot_multiplier, dt_multiplier"),
    x
      .from("rate_card")
      .select(
        "rate_card_id, role_code, worker_classification, pay_basis, arrangement, overtime_rule_id, currency_code",
      ),
  ]);
  for (const r of [classes, bases, arrangements, rules, cards]) {
    if (r.error) return fail(toDataError(r.error));
  }
  return ok({
    classifications: [...(classes.data ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => ({ code: c.code, label: c.label })),
    payBases: (bases.data ?? []).map((b) => ({
      payBasis: b.pay_basis,
      classification: b.worker_classification,
    })),
    arrangements: (arrangements.data ?? []).map((a) => ({
      arrangement: a.arrangement,
      classification: a.worker_classification,
    })),
    overtimeRules: (rules.data ?? [])
      .map((r) => ({
        id: r.rule_id,
        name: r.name,
        otMultiplier: Number(r.ot_multiplier),
        dtMultiplier: Number(r.dt_multiplier),
      }))
      .sort((a, b) => byCode(a.id, b.id)),
    canonRateCards: (cards.data ?? [])
      .map((c) => ({
        id: c.rate_card_id,
        roleCode: c.role_code,
        classification: c.worker_classification,
        payBasis: c.pay_basis,
        arrangement: c.arrangement,
        overtimeRuleId: c.overtime_rule_id,
        currencyCode: c.currency_code,
      }))
      .sort((a, b) => byCode(a.id, b.id)),
  });
}

// Pay rate ledger ------------------------------------------------------------------------------------------

export interface PayRate {
  readonly id: string;
  readonly member: MemberRef;
  readonly roleCode: string;
  readonly currencyCode: string;
  readonly effectiveFrom: string;
  readonly rateMinor: number | null;
  readonly masked: boolean;
}

/** The pay rate ledger, newest effective date first, rates masked as the caller's access requires. */
export async function listPayRates(
  db: XosClient,
  filter: { readonly orgId: string; readonly membershipId?: string },
): Promise<Result<PayRate[]>> {
  let query = db
    .from("pay_rates_masked")
    .select("id, membership_id, role_code, currency_code, effective_from, rate_minor, is_masked")
    .eq("org_id", filter.orgId);
  if (filter.membershipId) query = query.eq("membership_id", filter.membershipId);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  const memberships = [...new Set(data.map((p) => p.membership_id).filter((m) => m !== null))];
  const people = new Map<string, MemberRef>();
  if (memberships.length > 0) {
    const m = await db.from("memberships").select(MEMBERSHIP_EMBED).in("id", memberships);
    if (m.error) return fail(toDataError(m.error));
    for (const row of m.data) people.set(row.id, toMemberRef(row, row.id));
  }
  return ok(
    data
      .map((p) => {
        const membershipId = p.membership_id ?? "";
        return {
          id: p.id ?? "",
          member: people.get(membershipId) ?? toMemberRef(null, membershipId),
          roleCode: p.role_code ?? "",
          currencyCode: p.currency_code ?? "",
          effectiveFrom: p.effective_from ?? "",
          rateMinor: p.is_masked ? null : p.rate_minor,
          masked: p.is_masked ?? true,
        };
      })
      .sort(
        (a, b) =>
          b.effectiveFrom.localeCompare(a.effectiveFrom) ||
          (a.member.name ?? "").localeCompare(b.member.name ?? ""),
      ),
  );
}

/** The rate in force for a person and role on a day: the latest entry effective on or before it. */
export function rateInForce(
  rates: readonly PayRate[],
  membershipId: string,
  roleCode: string,
  day: string,
): PayRate | null {
  return (
    rates
      .filter(
        (r) =>
          r.member.membershipId === membershipId &&
          r.roleCode === roleCode &&
          r.effectiveFrom <= day,
      )
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null
  );
}

/** Appends a pay rate to the ledger (org.payroll.write); entries are never edited. */
export async function recordPayRate(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly membershipId: string;
    readonly roleCode: string;
    readonly rateMinor: number;
    readonly currencyCode: string;
    readonly effectiveFrom: string;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("pay_rates")
    .insert({
      org_id: input.orgId,
      membership_id: input.membershipId,
      role_code: input.roleCode,
      rate_minor: input.rateMinor,
      currency_code: input.currencyCode,
      effective_from: input.effectiveFrom,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Currencies the org can price in (private.currencies through app.currencies), by code. */
export async function listCurrencies(db: XosClient): Promise<Result<string[]>> {
  const { data, error } = await db.from("currencies").select("currency_code");
  if (error) return fail(toDataError(error));
  return ok(
    data
      .map((c) => c.currency_code ?? "")
      .filter((c) => c !== "")
      .sort(),
  );
}
