import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as schemas from "../src/index.ts";
import {
  MoneyTotal,
  RecordState,
  canonCodes,
  defineResource,
  exampleOf,
  fields,
  maskable,
  page,
  type ResourceDefinition,
} from "../src/index.ts";

const modules = [
  schemas.canon,
  schemas.projects,
  schemas.records,
  schemas.operations,
  schemas.workforce,
  schemas.finance,
  schemas.safety,
  schemas.marketplace,
  schemas.identity,
  schemas.platform,
];

function isResource(value: unknown): value is ResourceDefinition {
  return typeof value === "object" && value !== null && "read" in value && "table" in value;
}

const resources = modules.flatMap((m) => Object.values(m).filter(isResource));

describe("resource definitions", () => {
  it("defines a large, uniquely named resource set", () => {
    expect(resources.length).toBeGreaterThan(150);
    const names = resources.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(resources.map((r) => [r.name, r] as const))("%s has a valid example", (_name, r) => {
    const example = exampleOf(r.read);
    const parsed = r.read.safeParse(example);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (r.create !== undefined) {
      const body = exampleOf(r.create);
      expect(r.create.safeParse(body).success).toBe(true);
    }
    if (r.update !== undefined) expect(r.update.safeParse({}).success).toBe(true);
  });

  it("uses snake_case field names and schema-qualified tables", () => {
    for (const r of resources) {
      expect(r.table).toMatch(/^(xpms|app|api_external)\.[a-z_]+$/);
      for (const k of Object.keys(r.read.shape)) expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("never accepts org_id or audit columns from the caller", () => {
    for (const r of resources) {
      if (r.create === undefined) continue;
      for (const k of ["id", "org_id", "created_at", "created_by", "updated_at", "updated_by"]) {
        expect(Object.keys(r.create.shape)).not.toContain(k);
      }
    }
  });

  it("keeps canon and view resources read-only", () => {
    for (const r of resources.filter((x) => x.base === "canon" || x.base === "view")) {
      expect(r.create).toBeUndefined();
      expect(r.update).toBeUndefined();
    }
  });
});

describe("money and masking", () => {
  it("keeps unpriced money as null and never coerces to zero", () => {
    const price = fields.money("Price.", 100);
    expect(price.parse(null)).toBeNull();
    expect(price.safeParse(1.5).success).toBe(false);
    const total = MoneyTotal.parse({ total_minor: null, currency: "USD", unpriced_count: 3 });
    expect(total.total_minor).toBeNull();
  });

  it("makes nullable fields optional on create", () => {
    const line = schemas.finance.BudgetLine;
    const body = exampleOf(line.create as z.ZodObject) as Record<string, unknown>;
    delete body["unit_price_minor"];
    expect(line.create?.safeParse(body).success).toBe(true);
  });

  it("masks Restricted fields in the read shape only", () => {
    const pay = schemas.workforce.PayRate;
    const read = exampleOf(pay.read) as Record<string, unknown>;
    expect(
      pay.read.safeParse({ ...read, rate_minor: { masked: true, reason: "No." } }).success,
    ).toBe(true);
    const body = exampleOf(pay.create as z.ZodObject) as Record<string, unknown>;
    expect(
      pay.create?.safeParse({ ...body, rate_minor: { masked: true, reason: "No." } }).success,
    ).toBe(false);
    expect(maskable(z.string()).safeParse("x").success).toBe(true);
  });
});

describe("codes and states", () => {
  it("validates canon codes by pattern rather than by hand-typed lists", () => {
    expect(canonCodes.DeptCode.safeParse("4000").success).toBe(true);
    expect(canonCodes.DeptCode.safeParse("4100").success).toBe(false);
    expect(canonCodes.Urid.safeParse("4000.01.01").success).toBe(true);
    expect(canonCodes.Urid.safeParse("4000.01.01.01").success).toBe(false);
    expect(canonCodes.ItemId.safeParse("4000.01.01-XPMS-001").success).toBe(true);
  });

  it("has the nine record states in lifecycle order", () => {
    expect(RecordState.options).toHaveLength(9);
    expect(RecordState.options).toContain("Canceled");
    expect(RecordState.options).not.toContain("Cancelled");
  });

  it("wraps items in the cursor page envelope", () => {
    const p = page(z.string(), "StringPage");
    expect(p.parse({ data: ["a"], next_cursor: null }).next_cursor).toBeNull();
  });
});

describe("defineResource guards", () => {
  it("rejects unknown serverSet, immutable and restricted fields", () => {
    const fieldsShape = { name: fields.text("Name.", "A") };
    for (const key of ["serverSet", "immutable", "restricted"] as const) {
      expect(() =>
        defineResource({
          name: "X",
          table: "app.x",
          description: "X.",
          fields: fieldsShape,
          [key]: ["nope"],
        }),
      ).toThrow(/not declared/);
    }
  });

  it("rejects an undeclared canon key", () => {
    expect(() =>
      defineResource({
        name: "Y",
        table: "xpms.y",
        description: "Y.",
        base: "canon",
        key: "y_code",
        fields: {},
      }),
    ).toThrow(/key/);
  });

  it("omits the update schema when nothing is writable after create", () => {
    const r = defineResource({
      name: "Z",
      table: "app.z",
      description: "Z.",
      immutable: ["a"],
      fields: { a: fields.ref("thing") },
    });
    expect(r.update).toBeUndefined();
  });

  it("throws when a leaf has no example", () => {
    expect(() => exampleOf(z.string())).toThrow(/No example/);
    expect(exampleOf(z.boolean())).toBe(true);
    expect(exampleOf(z.literal("a"))).toBe("a");
    expect(exampleOf(z.enum(["b", "c"]))).toBe("b");
    expect(exampleOf(z.string().meta({ example: "x" }).default("x"))).toBe("x");
  });
});
