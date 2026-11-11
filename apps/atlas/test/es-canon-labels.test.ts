import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as enums from "@xos/data/enums";
import { hasFieldHistory } from "@xos/data/field-history";
import { describe, expect, it } from "vitest";
import canonGl from "../../../packages/i18n/canon/en-US/glAccount.json";
import { glAccountName } from "@/lib/finance/gl-account-labels";
import { historyStateKey, STATE_VALUE_LABELS } from "@/lib/history/fields";
import { gateCriterionKey, localizeCriteria } from "@/lib/projects/gate-criteria";

/**
 * Crawl 4.9, es-US: gate criteria stayed English, report GL rows read "Expense · Environment", and a
 * purchase order's field history read the stored "Proposed" while its state history said "Borrador".
 */
const MESSAGES = join(__dirname, "../../../packages/i18n/messages");
type Tree = { readonly [key: string]: string | Tree };

function catalog(locale: string): Tree {
  const out: Record<string, Tree> = {};
  for (const ns of ["projects", "reports", "procurement", "finance", "people"]) {
    out[ns] = JSON.parse(readFileSync(join(MESSAGES, locale, `${ns}.json`), "utf8")) as Tree;
  }
  return out;
}

function lookup(tree: Tree, key: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of key.split(".")) {
    if (node === undefined || typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

const en = catalog("en-US");
const es = catalog("es-US");
const translator = (tree: Tree) => ({
  t: (key: string) => lookup(tree, key) ?? key,
  has: (key: string) => lookup(tree, key) !== undefined,
});

/** The 35 canon criteria as 0150 seeds them. */
function canonCriteria(): { id: string; statement: string }[] {
  const sql = readFileSync(
    join(__dirname, "../../../supabase/migrations/0150_xpms_canon_seed.sql"),
    "utf8",
  );
  const start = sql.indexOf("insert into xpms.dim_gate_criterion");
  const block = sql.slice(start, sql.indexOf(";\n", start));
  return [
    ...block.matchAll(/\('(G\d\.[A-Z_]+)', \d+, \d+, '((?:[^']|'')*)', (?:true|false)\)/g),
  ].map((m) => ({ id: m[1] ?? "", statement: (m[2] ?? "").replace(/''/g, "'") }));
}

describe("gate criteria", () => {
  const criteria = canonCriteria();

  it("has every canon criterion in en-US as canon words it, and in Spanish in es-US", () => {
    expect(criteria).toHaveLength(35);
    for (const c of criteria) {
      expect(lookup(en, gateCriterionKey(c.id))).toBe(c.statement);
      const spanish = lookup(es, gateCriterionKey(c.id));
      expect(spanish).toBeTruthy();
      expect(spanish).not.toBe(c.statement);
    }
  });

  it("localizes statements and keeps canon English for a criterion the catalog does not know", () => {
    const { t, has } = translator(es);
    const [budget] = localizeCriteria(criteria.slice(0, 1), t, has);
    expect(budget?.statement).toBe("Existe un techo presupuestario y está aprobado.");
    expect(budget?.id).toBe("G1.BUDGET_ENVELOPE");
    const unknown = { id: "G9.NEW_ONE", statement: "Something new." };
    expect(localizeCriteria([unknown], t, has)).toEqual([unknown]);
  });
});

describe("GL account names", () => {
  it("has every canon account in en-US as canon names it, and in Spanish in es-US", () => {
    for (const [code, name] of Object.entries(canonGl)) {
      expect(lookup(en, `reports.glAccounts.${code}`)).toBe(name);
      expect(lookup(es, `reports.glAccounts.${code}`)).toBeTruthy();
    }
    const { t, has } = translator(es);
    expect(glAccountName("5400", "Expense · Environment", t, has)).toBe("Gastos · Entorno");
    expect(glAccountName("9999", "Custom", t, has)).toBe("Custom");
    expect(glAccountName("9999", undefined, t, has)).toBe("9999");
  });
});

describe("field history state values", () => {
  const values: Record<string, readonly string[]> = {
    "app.purchase_orders.po_state": enums.poState,
    "app.rfqs.rfq_state": enums.rfqState,
    "app.submittals.submittal_state": enums.reviewState,
    "app.requisitions.requisition_state": enums.requisitionState,
    "app.expenses.expense_state": enums.expenseState,
    "app.change_orders.change_order_state": enums.changeOrderState,
    "app.invoices.invoice_state": enums.invoiceState,
    "app.payments.payment_state": enums.paymentState,
    "app.journal_entries.journal_state": enums.journalState,
    "app.settlements.settlement_state": enums.settlementState,
  };

  it("words a purchase order's state the way its state history does", () => {
    const key = historyStateKey("app.purchase_orders", "po_state", "Proposed");
    expect(key).toBe("procurement.poStates.Proposed");
    expect(lookup(en, key ?? "")).toBe("Draft");
    expect(lookup(es, key ?? "")).toBe("Borrador");
    expect(historyStateKey("app.purchase_orders", "notes", "Proposed")).toBeNull();
    expect(historyStateKey("app.purchase_orders", "po_state", 3)).toBeNull();
  });

  it("covers field history subjects only, with a label for every state in both languages", () => {
    expect(Object.keys(values).sort()).toEqual(Object.keys(STATE_VALUE_LABELS).sort());
    for (const [column, states] of Object.entries(values)) {
      const [schema, table, field] = column.split(".");
      expect(hasFieldHistory(`${schema}.${table}`)).toBe(true);
      for (const state of states) {
        const key = historyStateKey(`${schema}.${table}`, field ?? "", state) ?? "";
        expect(lookup(en, key), key).toBeTruthy();
        expect(lookup(es, key), key).toBeTruthy();
      }
    }
  });
});
