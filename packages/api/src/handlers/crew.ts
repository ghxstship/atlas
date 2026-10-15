/**
 * Crew handlers (A13). Served here are the operations whose v1 contract matches the Crew schema:
 * pay periods with their compare-and-set transitions (a posted period never reopens, invariant 14),
 * rate cards, earning codes and time off policies. Reads and writes run as the caller, so row level
 * security decides every row. Rate cards and earning codes use their column names, as corrected in
 * catalog/modules/crew.ts (ADR 0023). The other Crew operations stay document-only until their
 * corrected shapes have handlers.
 */
import type { XosClient } from "@xos/data";
import { transitionPayPeriod, type PayPeriodState } from "@xos/data/crew";
import type { Components } from "../contract/operations.generated.ts";
import { conflict, notFound, preconditionFailed } from "../problem.ts";
import { requireOrg } from "../runtime/context.ts";
import { versionFromIfMatch } from "../runtime/etag.ts";
import { created, defineHandlers, noContent, ok } from "../runtime/handler.ts";
import { listPage } from "../runtime/listing.ts";
import { selectColumns } from "../runtime/pagination.ts";
import { problemFor } from "./projects.ts";

type Row = Record<string, unknown>;
type Table = "pay_periods" | "rate_cards" | "earning_codes" | "time_off_policies";

const BASE = ["id", "org_id", "created_at", "created_by", "updated_at", "updated_by"] as const;
const PERIOD_COLUMNS = [...BASE, "starts_on", "ends_on", "pay_period_state"] as const;
const CARD_COLUMNS = [...BASE, "name", "currency_code", "effective_from", "effective_to"] as const;
const CODE_COLUMNS = [...BASE, "code", "name", "is_overtime"] as const;
const POLICY_COLUMNS = [...BASE, "name", "accrual_hours_per_period"] as const;

function live(db: XosClient, table: Table) {
  return { select: (c: string) => db.from(table).select(c).is("deleted_at", null) };
}

async function readOne(db: XosClient, table: Table, id: string, select: string, label: string) {
  const { data, error } = await db
    .from(table)
    .select(select)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw notFound(`No ${label} with id ${id} is visible to you.`);
  return data as unknown as Row;
}

/** A compare-and-set update on updated_at from If-Match; 412 when stale, 404 when hidden. */
async function guardedUpdate(
  db: XosClient,
  table: Table,
  id: string,
  patch: Row,
  ifMatch: string | undefined,
  label: string,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  const version = versionFromIfMatch(ifMatch ?? "*");
  let update = db
    .from(table)
    .update(patch as never)
    .eq("id", id)
    .is("deleted_at", null);
  if (version !== null) update = update.eq("updated_at", version);
  const { data, error } = await update.select("id").maybeSingle();
  if (error !== null) throw error;
  if (data === null) {
    await readOne(db, table, id, "id", label);
    throw preconditionFailed();
  }
}

async function softDelete(db: XosClient, table: Table, id: string, label: string) {
  const { data, error } = await db
    .from(table)
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw notFound(`No ${label} with id ${id} is visible to you.`);
  return noContent();
}

function defined(body: Row): Row {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

export const handlers = defineHandlers("Crew", {
  // Pay periods ------------------------------------------------------------------------------------
  "payPeriods.list": async ({ query }, { db }) =>
    ok(
      await listPage<Components["PayPeriod"]>(live(db, "pay_periods"), query, {
        columns: PERIOD_COLUMNS,
        key: "id",
        defaultOrder: ["starts_on"],
      }),
    ),

  "payPeriods.get": async ({ params, query }, { db }) =>
    ok(
      (await readOne(
        db,
        "pay_periods",
        params.id,
        selectColumns(query.fields, PERIOD_COLUMNS, "id").join(","),
        "pay period",
      )) as unknown as Components["PayPeriod"],
    ),

  "payPeriods.create": async ({ body }, context) => {
    const { data, error } = await context.db
      .from("pay_periods")
      .insert({ org_id: requireOrg(context).id, starts_on: body.starts_on, ends_on: body.ends_on })
      .select(PERIOD_COLUMNS.join(","))
      .single();
    if (error !== null) throw error;
    return created(data as unknown as Components["PayPeriod"]);
  },

  "payPeriods.update": async ({ params, body, ifMatch }, { db }) => {
    await guardedUpdate(
      db,
      "pay_periods",
      params.id,
      defined({ starts_on: body.starts_on, ends_on: body.ends_on }),
      ifMatch,
      "pay period",
    );
    return ok(
      (await readOne(
        db,
        "pay_periods",
        params.id,
        PERIOD_COLUMNS.join(","),
        "pay period",
      )) as unknown as Components["PayPeriod"],
    );
  },

  "payPeriods.transition": async ({ params, body }, { db }) => {
    const current = await readOne(
      db,
      "pay_periods",
      params.id,
      PERIOD_COLUMNS.join(","),
      "pay period",
    );
    if (current["pay_period_state"] !== body.expected_state) {
      throw conflict(
        `The pay period is ${String(current["pay_period_state"])}, not ${body.expected_state}; read it again.`,
      );
    }
    const result = await transitionPayPeriod(
      db,
      params.id,
      body.expected_state as PayPeriodState,
      body.to_state as PayPeriodState,
      body.reason ?? "",
    );
    if (!result.ok) throw problemFor(result.error);
    return ok(
      (await readOne(
        db,
        "pay_periods",
        params.id,
        PERIOD_COLUMNS.join(","),
        "pay period",
      )) as unknown as Components["PayPeriod"],
    );
  },

  // Rate cards -----------------------------------------------------------------------------------------
  "rateCards.list": async ({ query }, { db }) =>
    ok(
      await listPage<Components["RateCard"]>(live(db, "rate_cards"), query, {
        columns: CARD_COLUMNS,
        key: "id",
        defaultOrder: ["effective_from"],
      }),
    ),

  "rateCards.get": async ({ params, query }, { db }) =>
    ok(
      (await readOne(
        db,
        "rate_cards",
        params.id,
        selectColumns(query.fields, CARD_COLUMNS, "id").join(","),
        "rate card",
      )) as unknown as Components["RateCard"],
    ),

  "rateCards.create": async ({ body }, context) => {
    const { data, error } = await context.db
      .from("rate_cards")
      .insert({
        org_id: requireOrg(context).id,
        name: body.name,
        currency_code: body.currency_code,
        effective_from: body.effective_from,
        effective_to: body.effective_to ?? null,
      })
      .select(CARD_COLUMNS.join(","))
      .single();
    if (error !== null) throw error;
    return created(data as unknown as Components["RateCard"]);
  },

  "rateCards.update": async ({ params, body, ifMatch }, { db }) => {
    await guardedUpdate(
      db,
      "rate_cards",
      params.id,
      defined({
        name: body.name,
        currency_code: body.currency_code,
        effective_from: body.effective_from,
        effective_to: body.effective_to,
      }),
      ifMatch,
      "rate card",
    );
    return ok(
      (await readOne(
        db,
        "rate_cards",
        params.id,
        CARD_COLUMNS.join(","),
        "rate card",
      )) as unknown as Components["RateCard"],
    );
  },

  "rateCards.delete": async ({ params }, { db }) =>
    softDelete(db, "rate_cards", params.id, "rate card"),

  // Earning codes (code order, Section 3.6) ----------------------------------------------------------------
  "earningCodes.list": async ({ query }, { db }) =>
    ok(
      await listPage<Components["EarningCode"]>(live(db, "earning_codes"), query, {
        columns: CODE_COLUMNS,
        key: "id",
        defaultOrder: ["code"],
      }),
    ),

  "earningCodes.get": async ({ params, query }, { db }) =>
    ok(
      (await readOne(
        db,
        "earning_codes",
        params.id,
        selectColumns(query.fields, CODE_COLUMNS, "id").join(","),
        "earning code",
      )) as unknown as Components["EarningCode"],
    ),

  "earningCodes.create": async ({ body }, context) => {
    const { data, error } = await context.db
      .from("earning_codes")
      .insert({
        org_id: requireOrg(context).id,
        code: body.code,
        name: body.name,
        is_overtime: body.is_overtime ?? false,
      })
      .select(CODE_COLUMNS.join(","))
      .single();
    if (error !== null) throw error;
    return created(data as unknown as Components["EarningCode"]);
  },

  "earningCodes.update": async ({ params, body, ifMatch }, { db }) => {
    await guardedUpdate(
      db,
      "earning_codes",
      params.id,
      defined({ code: body.code, name: body.name, is_overtime: body.is_overtime }),
      ifMatch,
      "earning code",
    );
    return ok(
      (await readOne(
        db,
        "earning_codes",
        params.id,
        CODE_COLUMNS.join(","),
        "earning code",
      )) as unknown as Components["EarningCode"],
    );
  },

  "earningCodes.delete": async ({ params }, { db }) =>
    softDelete(db, "earning_codes", params.id, "earning code"),

  // Time off policies ---------------------------------------------------------------------------------------
  "timeOffPolicies.list": async ({ query }, { db }) =>
    ok(
      await listPage<Components["TimeOffPolicy"]>(live(db, "time_off_policies"), query, {
        columns: POLICY_COLUMNS,
        key: "id",
        defaultOrder: ["name"],
      }),
    ),

  "timeOffPolicies.get": async ({ params, query }, { db }) =>
    ok(
      (await readOne(
        db,
        "time_off_policies",
        params.id,
        selectColumns(query.fields, POLICY_COLUMNS, "id").join(","),
        "time off policy",
      )) as unknown as Components["TimeOffPolicy"],
    ),

  "timeOffPolicies.create": async ({ body }, context) => {
    const { data, error } = await context.db
      .from("time_off_policies")
      .insert({
        org_id: requireOrg(context).id,
        name: body.name,
        accrual_hours_per_period: body.accrual_hours_per_period ?? null,
      })
      .select(POLICY_COLUMNS.join(","))
      .single();
    if (error !== null) throw error;
    return created(data as unknown as Components["TimeOffPolicy"]);
  },

  "timeOffPolicies.update": async ({ params, body, ifMatch }, { db }) => {
    await guardedUpdate(
      db,
      "time_off_policies",
      params.id,
      defined({ name: body.name, accrual_hours_per_period: body.accrual_hours_per_period }),
      ifMatch,
      "time off policy",
    );
    return ok(
      (await readOne(
        db,
        "time_off_policies",
        params.id,
        POLICY_COLUMNS.join(","),
        "time off policy",
      )) as unknown as Components["TimeOffPolicy"],
    );
  },

  "timeOffPolicies.delete": async ({ params }, { db }) =>
    softDelete(db, "time_off_policies", params.id, "time off policy"),
});
