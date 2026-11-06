import pg from "pg";

/** Fixtures of B13's journeys, as postgres on the local stack only (RRR-237). */

export const DEMO_ORG_ID = "01920000-0000-7000-8000-000000000001";
/** The demo project (seed 0107, key NWS). */
export const DEMO_PROJECT = "01920000-0000-7000-8000-000000001001";

export async function localSql<T extends Record<string, unknown>>(
  text: string,
  args: unknown[] = [],
): Promise<T[]> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) {
    throw new Error("B13's journeys change data only on a local Supabase stack.");
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(text, args)).rows as T[];
  } finally {
    await client.end();
  }
}

/** A budget on the demo project with priced lines, and its id. */
export async function newBudget(name: string, markupBp: number | null = null): Promise<string> {
  const [row] = await localSql<{ id: string }>(
    `insert into app.budgets (org_id, project_id, name, currency_code, default_markup_bp)
     values ($1, $2, $3, 'USD', $4) returning id`,
    [DEMO_ORG_ID, DEMO_PROJECT, name, markupBp],
  );
  return row?.id as string;
}

export async function newLine(
  budgetId: string,
  n: number,
  description: string,
  priceMinor: number | null,
  lineType = "Cost",
): Promise<string> {
  const [row] = await localSql<{ id: string }>(
    `insert into app.budget_lines (org_id, budget_id, line_number, description, urid, line_type, quantity, unit_price_minor, xyz, xyz_basis)
     values ($1, $2, $3, $4, $5, $6, 2, $7, 'X', 'Declared') returning id`,
    [DEMO_ORG_ID, budgetId, n, description, lineType === "Labor" ? "5000.51.02" : "5000.04.02", lineType, priceMinor],
  );
  return row?.id as string;
}

export async function removeBudget(budgetId: string): Promise<void> {
  await localSql(`update app.budget_lines set deleted_at = now() where budget_id = $1`, [budgetId]);
  await localSql(`alter table app.budgets disable trigger t41_guard_budget_sent_quote`);
  await localSql(`update app.budgets set deleted_at = now() where id = $1`, [budgetId]);
  await localSql(`alter table app.budgets enable trigger t41_guard_budget_sent_quote`);
}
