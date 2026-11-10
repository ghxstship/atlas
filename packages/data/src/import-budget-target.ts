import * as enums from "./enums.generated.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BudgetDestination } from "./import-worker.ts";
import type { RowCheck } from "./import-material-target.ts";

/**
 * The budget_lines import target (B13, G-214, 6558), loaded only for it, because import-run's boot has a ceiling.
 */

const BUDGET_LINE_TYPES = enums.budgetLineType;

/** A number of at least zero, or null. */
function nonNegative(text: string): number | null {
  const cleaned = text.trim().replace(/,/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Major units of a currency as integer minor units, half away from zero; null when it is no amount. */
function minorUnits(text: string, exponent: number): number | null {
  const n = nonNegative(text.replace(/^\s*[$€£¥]/u, ""));
  return n === null ? null : Math.round(n * 10 ** exponent);
}

export async function checkBudgetLineRow(
  input: Omit<RowCheck, "orgId"> & {
    readonly orgId: string;
    readonly bounded: (field: string) => void;
  },
): Promise<void> {
  const { destination, lookups, text, set, bounded, orgId, columnOf, values, issues } = input;
  const budget = destination.budget;
  const exponent = budget?.exponent ?? 2;
  bounded("description");
  // Canon units are exact lower-case aliases, so Day and day are one unit and hrs is a per-cell reason, never a
  // foreign key message at commit.
  await set(
    "unit_basis",
    async (v) => {
      const unit = v.trim().toLowerCase();
      return (await lookups.unitExists(unit)) ? unit : null;
    },
    "unknown_unit",
  );
  await set("urid", (v) => lookups.uridExists(v), "unknown_urid");
  await set(
    "line_number",
    (v) => (/^\d{1,6}$/.test(v.trim()) && Number(v) > 0 ? Number(v) : null),
    "invalid_line_number",
  );
  await set("quantity", (v) => nonNegative(v), "invalid_quantity");
  // The word Unpriced clears a price. A blank cell says nothing here: a new line takes the defaults in
  // createValues, where its price is NULL and never zero (S3.7-02), and an update leaves the value alone.
  const price = text("unit_price").trim();
  if (price.toLowerCase() === "unpriced") {
    values["unit_price_minor"] = null;
  } else if (price !== "") {
    const minor = minorUnits(price, exponent);
    if (minor === null)
      issues.push({ columnIndex: columnOf("unit_price"), issue: "invalid_price" });
    else values["unit_price_minor"] = minor;
  }
  const type = text("line_type").trim();
  if (type !== "") {
    const known = BUDGET_LINE_TYPES.find((k) => k.toLowerCase() === type.toLowerCase());
    if (known) values["line_type"] = known;
    else issues.push({ columnIndex: columnOf("line_type"), issue: "invalid_line_type" });
  }
  await set(
    "cost_center",
    (v) => lookups.costCenterId(orgId, v),
    "unknown_cost_center",
    "cost_center_id",
  );
  await set("element_id", (v) => lookups.elementExists(v.trim()), "unknown_element");
  for (const [field, kind, issue] of [
    ["grade_code", "grade", "unknown_grade"],
    ["phase_code", "phase", "unknown_phase"],
    ["tier_code", "tier", "unknown_tier"],
  ] as const) {
    await set(
      field,
      async (v) => ((await lookups.canonCodeExists(kind, v.trim())) ? v.trim() : null),
      issue,
    );
  }
  const declared = text("xyz").trim().toUpperCase();
  if (declared !== "") {
    if (declared === "X" || declared === "Y" || declared === "Z") {
      values["xyz"] = declared;
      values["xyz_basis"] = "Declared";
    } else issues.push({ columnIndex: columnOf("xyz"), issue: "invalid_xyz" });
  } else if (text("urid")) {
    const tag = await lookups.uridXyz(text("urid"));
    if (tag) {
      values["xyz"] = tag;
      values["xyz_basis"] = "Category";
    } else issues.push({ columnIndex: columnOf("urid"), issue: "xyz_required" });
  }
  await set(
    "markup_percent",
    (v) => {
      const n = Number(v.trim().replace(/%$/, ""));
      return Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.round(n * 100) : null;
    },
    "invalid_markup",
    "markup_bp",
  );
  await set(
    "client_unit_price",
    (v) => minorUnits(v.trim(), exponent),
    "invalid_price",
    "client_unit_price_minor",
  );
  const excluded = text("excluded_from_quote").trim().toLowerCase();
  if (excluded !== "") {
    if (["true", "yes", "1"].includes(excluded)) values["excluded_from_quote"] = true;
    else if (["false", "no", "0"].includes(excluded)) values["excluded_from_quote"] = false;
    else issues.push({ columnIndex: columnOf("excluded_from_quote"), issue: "invalid_boolean" });
  }
}

type StoreSchema = ReturnType<SupabaseClient<never, "app">["schema"]>;
type OneRow = (
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  what: string,
) => Promise<Record<string, unknown> | null>;

/** A budget line's URID and how its tag was set, for an update through the sheet. */
export async function readBudgetLineTag(app: StoreSchema, one: OneRow, id: string) {
  const line = await one(
    app.from("budget_lines").select("urid, xyz_basis").eq("id", id),
    "budget_lines",
  );
  if (!line) return null;
  return {
    urid: typeof line["urid"] === "string" ? line["urid"] : "",
    xyzBasis: typeof line["xyz_basis"] === "string" ? line["xyz_basis"] : null,
  };
}

/** What validating and numbering lines needs from the destination budget; null when it is gone. */
export async function readBudgetDestination(
  app: StoreSchema,
  one: OneRow,
  budgetId: string,
): Promise<BudgetDestination | null> {
  const budget = await one(
    app.from("budgets").select("currency_code").eq("id", budgetId).is("deleted_at", null),
    "budgets",
  );
  if (!budget) return null;
  const [currency, last] = await Promise.all([
    one(
      app
        .from("currencies")
        .select("minor_unit_exponent")
        .eq("currency_code", String(budget["currency_code"])),
      "currencies",
    ),
    one(
      app
        .from("budget_lines")
        .select("line_number")
        .eq("budget_id", budgetId)
        .is("deleted_at", null)
        .order("line_number", { ascending: false })
        .limit(1),
      "budget_lines",
    ),
  ]);
  return {
    id: budgetId,
    exponent:
      typeof currency?.["minor_unit_exponent"] === "number" ? currency["minor_unit_exponent"] : 2,
    maxLineNumber: typeof last?.["line_number"] === "number" ? last["line_number"] : 0,
  };
}
