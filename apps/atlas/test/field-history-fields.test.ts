import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FIELD_HISTORY_SUBJECTS } from "@xos/data/field-history";
import { getMessages } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import { historyLabelKey, historyValue, isHiddenHistoryField } from "../lib/history/fields";

/**
 * Field history on every record page (A131, Section 4.10): a record page without labels of its own
 * names each field from the shared column dictionary, so every column a subject's history can show
 * has a label in en-US and es-US, and values are worded by their column's shape.
 */
const types = readFileSync(
  fileURLToPath(new URL("../../../packages/data/src/database.types.ts", import.meta.url)),
  "utf8",
);
/** Pages that word their history with labels of their own (record-detail, SOPs, custom objects). */
const OWN_LABELS = new Set(["app.records", "app.sops", "app.custom_object_records"]);

function columnsOf(table: string): string[] {
  const name = table.slice("app.".length);
  const app = types.slice(types.indexOf("\n  app: {"));
  const row = new RegExp(`\\n {6}${name}: \\{\\n {8}Row: \\{\\n([\\s\\S]*?)\\n {8}\\}`).exec(app);
  if (!row?.[1]) throw new Error(`No row type for ${table}`);
  return [...row[1].matchAll(/^ {10}([a-z0-9_]+)\??:/gm)].map((m) => m[1] ?? "");
}

function flatten(value: unknown, prefix = "", out = new Map<string, string>()) {
  if (typeof value === "string") out.set(prefix, value);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

const t = (key: string, values?: Record<string, string | number>) =>
  values ? `<${key} ${JSON.stringify(values)}>` : `<${key}>`;
const format = {
  t,
  dateTime: (iso: string) => `instant ${iso}`,
  date: (day: string) => `day ${day}`,
  number: (n: number, digits?: number) => (digits === undefined ? String(n) : n.toFixed(digits)),
  money: (minor: number, code: string, exponent: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(minor / 10 ** exponent),
};

describe("field history labels", () => {
  it("labels every column a record page's history can show, in en-US and es-US", () => {
    const keys = new Set(
      [...FIELD_HISTORY_SUBJECTS]
        .filter((table) => !OWN_LABELS.has(table))
        .flatMap(columnsOf)
        .flatMap((column) => historyLabelKey(column) ?? []),
    );
    expect(keys.size).toBeGreaterThan(200);
    expect([...keys].filter((key) => key.startsWith("collab.history.money.")).length).toBe(14);
    for (const locale of ["en-US", "es-US"] as const) {
      const catalog = flatten(getMessages(locale));
      expect(
        [...keys].filter((key) => !catalog.get(key)),
        locale,
      ).toEqual([]);
      // An amount reads in its currency, so its label never says it is in minor units.
      expect(
        [...keys].filter(
          (key) =>
            key.startsWith("collab.history.money.") &&
            /minor|menores/i.test(catalog.get(key) ?? ""),
        ),
        locale,
      ).toEqual([]);
      for (const key of ["collab.history.yes", "collab.history.no", "collab.history.minorUnits"]) {
        expect(catalog.get(key), `${locale} ${key}`).toBeTruthy();
      }
    }
  });

  it("leaves out keys, references and bookkeeping, and words Trash on its own", () => {
    for (const field of ["id", "org_id", "budget_line_id", "approved_by", "beo_display_key"]) {
      expect(isHiddenHistoryField(field), field).toBe(true);
      expect(historyLabelKey(field), field).toBeNull();
    }
    expect(historyLabelKey("deleted_at")).toBe("collab.history.trash");
    expect(historyLabelKey("description")).toBe("views.export.columns.description");
    expect(historyLabelKey("amount_minor")).toBe("collab.history.money.amount_minor");
  });

  it("words an amount in its currency, by that currency's exponent", () => {
    const usd = { code: "USD", exponent: 2 };
    expect(historyValue("amount_minor", 80000, format, usd)).toBe("$800.00");
    expect(historyValue("amount_minor", 500, format, { code: "JPY", exponent: 0 })).toBe("¥500");
    expect(historyValue("amount_minor", 12345, format, { code: "KWD", exponent: 3 })).toMatch(
      /^KWD\s12\.345$/,
    );
    // Without a currency, the stored minor units, said as such, never a guessed major amount.
    expect(historyValue("amount_minor", 80000, format)).toBe(
      '<collab.history.minorUnits {"amount":"80000"}>',
    );
    expect(historyValue("pallet_count", 12, format, usd)).toBe("12");
  });

  it("words a value by its column", () => {
    expect(historyValue("is_remote", true, format)).toBe("<collab.history.yes>");
    expect(historyValue("is_remote", false, format)).toBe("<collab.history.no>");
    expect(historyValue("pallet_count", 12, format)).toBe("12");
    expect(historyValue("posted_at", "2027-06-10T14:00:00+00:00", format)).toBe(
      "instant 2027-06-10T14:00:00+00:00",
    );
    expect(historyValue("end_date", "2027-08-31", format)).toBe("day 2027-08-31");
    expect(historyValue("description", "Deck rental deposit.", format)).toBe(
      "Deck rental deposit.",
    );
    const long = historyValue("body", "x".repeat(400), format);
    expect(long).toHaveLength(160);
    expect(long.endsWith("...")).toBe(true);
    expect(historyValue("tags", ["a", "b"], format)).toBe('["a","b"]');
  });
});
