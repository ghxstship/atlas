import { describe, expect, it } from "vitest";
import {
  checkCustomFieldInputs,
  CUSTOM_FIELD_TABLES,
  decimalToMinor,
  inputOfValue,
  isCustomFieldTable,
  listCustomFieldDefinitions,
  listCustomFieldValues,
  localTimeIn,
  matchCustomFieldConditions,
  minorToDecimal,
  operatorsFor,
  parseCustomFieldInput,
  rowOfValue,
  valueColumn,
  valueOfRow,
  writeCustomFieldValues,
  type CustomField,
  type CustomFieldValue,
} from "../src/custom-fields.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/**
 * Custom field values on built-in tables (A117, RRR-162): definitions per table, every data type's value read
 * from and written to its typed column, required and malformed inputs caught before anything is written, and
 * view filters judged on custom_field_values.
 */

const context = {
  timeZone: "America/New_York",
  exponents: new Map([
    ["USD", 2],
    ["JPY", 0],
  ]),
};

function field(dataType: CustomField["dataType"], extra: Partial<CustomField> = {}): CustomField {
  const key = extra.key ?? dataType.toLowerCase();
  return {
    id: `id-${key}`,
    targetTable: "app.projects",
    key,
    label: extra.label ?? dataType,
    dataType,
    required: false,
    filterable: true,
    sortOrder: 1,
    choices: [],
    ...extra,
  };
}

const tier = field("Choice", {
  key: "tier",
  choices: [
    { id: "c-gold", key: "gold", label: "Gold" },
    { id: "c-silver", key: "silver", label: "Silver" },
  ],
});

const EMPTY_ROW = {
  value_text: null,
  value_number: null,
  value_money_minor: null,
  value_currency: null,
  value_date: null,
  value_timestamp: null,
  value_boolean: null,
  value_choice_id: null,
  value_person_id: null,
};

describe("custom field tables", () => {
  it("lists the built-in tables orgs may extend (0540), spaces and signs among them (B1)", () => {
    expect(CUSTOM_FIELD_TABLES).toEqual(
      expect.arrayContaining(["app.venues", "app.asset_units", "app.spaces", "app.signs"]),
    );
    expect(isCustomFieldTable("app.asset_units")).toBe(true);
    expect(isCustomFieldTable("app.signs")).toBe(true);
    expect(isCustomFieldTable("app.audit_events")).toBe(false);
    expect(isCustomFieldTable(7)).toBe(false);
  });
});

describe("reading definitions", () => {
  it("reads one table's live fields with live choices in order", async () => {
    const { db, calls } = fakeClient({
      "from:custom_field_definitions": [
        okResponse([
          {
            id: "f1",
            target_table: "app.projects",
            field_key: "tier",
            label: "Tier",
            data_type: "Choice",
            required: true,
            filterable: true,
            sort_order: 10,
            custom_field_choices: [
              { id: "c2", choice_key: "silver", label: "Silver", sort_order: 2, deleted_at: null },
              {
                id: "c3",
                choice_key: "old",
                label: "Old",
                sort_order: 0,
                deleted_at: "2026-01-01",
              },
              { id: "c1", choice_key: "gold", label: "Gold", sort_order: 1, deleted_at: null },
            ],
          },
        ]),
      ],
    });
    const result = await listCustomFieldDefinitions(db, "org-1", "app.projects");
    expect(result).toEqual({
      ok: true,
      data: [
        {
          id: "f1",
          targetTable: "app.projects",
          key: "tier",
          label: "Tier",
          dataType: "Choice",
          required: true,
          filterable: true,
          sortOrder: 10,
          choices: [
            { id: "c1", key: "gold", label: "Gold" },
            { id: "c2", key: "silver", label: "Silver" },
          ],
        },
      ],
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["target_table", "app.projects"]]);
    expect(calls[0]?.steps).toContainEqual(["is", ["deleted_at", null]]);
  });

  it("reports a failed read", async () => {
    const { db } = fakeClient({
      "from:custom_field_definitions": [errorResponse("42501", "denied")],
    });
    expect(await listCustomFieldDefinitions(db, "org-1", "app.vendors")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});

describe("typed columns", () => {
  const values: CustomFieldValue[] = [
    { type: "Text", text: "Dock 4" },
    { type: "Email", text: "ops@example.com" },
    { type: "URL", text: "https://example.com" },
    { type: "Number", number: 12.5 },
    { type: "Money", minor: 250000, currency: "USD" },
    { type: "Date", date: "2026-11-02" },
    { type: "Timestamp", at: "2026-11-02T14:30:00.000Z" },
    { type: "Boolean", boolean: false },
    { type: "Choice", choiceId: "c-gold" },
    { type: "Person", personId: "11111111-2222-4333-8444-555555555555" },
  ];

  it.each(values)("writes and reads a $type value in its own column only", (value) => {
    const row = rowOfValue(value);
    const filled = Object.entries(row).filter(([, v]) => v !== null);
    const column = valueColumn(value.type);
    expect(filled.map(([k]) => k)).toEqual(
      value.type === "Money" ? ["value_money_minor", "value_currency"] : [column],
    );
    expect(valueOfRow(value.type, row)).toEqual(value);
  });

  it("reads an empty column as no value", () => {
    for (const value of values) expect(valueOfRow(value.type, EMPTY_ROW)).toBeNull();
    expect(valueOfRow("Money", { ...EMPTY_ROW, value_money_minor: 5 })).toBeNull();
  });
});

describe("parsing what a form holds", () => {
  it("reads every data type from its input text", () => {
    const ok = (f: CustomField, value: string, currency?: string) =>
      parseCustomFieldInput(f, currency ? { value, currency } : { value }, context);
    expect(ok(field("Text"), "  Dock 4 ")).toEqual({
      ok: true,
      value: { type: "Text", text: "Dock 4" },
    });
    expect(ok(field("Email"), "ops@example.com")).toMatchObject({ ok: true });
    expect(ok(field("Email"), "ops at example")).toEqual({ ok: false, problem: "invalid" });
    expect(ok(field("URL"), "https://example.com/a")).toMatchObject({ ok: true });
    expect(ok(field("URL"), "example.com")).toEqual({ ok: false, problem: "invalid" });
    expect(ok(field("Number"), "1,200.5")).toEqual({
      ok: true,
      value: { type: "Number", number: 1200.5 },
    });
    expect(ok(field("Number"), "twelve")).toEqual({ ok: false, problem: "invalid" });
    expect(ok(field("Money"), "2,500.50", "usd")).toEqual({
      ok: true,
      value: { type: "Money", minor: 250050, currency: "USD" },
    });
    expect(ok(field("Money"), "2500.5", "JPY")).toEqual({ ok: false, problem: "invalid" });
    expect(ok(field("Money"), "2500")).toEqual({ ok: false, problem: "currency" });
    expect(ok(field("Date"), "2026-11-02")).toEqual({
      ok: true,
      value: { type: "Date", date: "2026-11-02" },
    });
    expect(ok(field("Date"), "2026-02-30")).toEqual({ ok: false, problem: "invalid" });
    expect(ok(field("Timestamp"), "2026-11-02T09:30")).toEqual({
      ok: true,
      value: { type: "Timestamp", at: "2026-11-02T14:30:00.000Z" },
    });
    expect(ok(field("Timestamp"), "tomorrow")).toEqual({ ok: false, problem: "invalid" });
    expect(ok(field("Boolean"), "true")).toEqual({
      ok: true,
      value: { type: "Boolean", boolean: true },
    });
    expect(ok(field("Boolean"), "false")).toEqual({
      ok: true,
      value: { type: "Boolean", boolean: false },
    });
    expect(ok(field("Boolean"), "yes")).toEqual({ ok: false, problem: "invalid" });
    expect(ok(tier, "gold")).toEqual({ ok: true, value: { type: "Choice", choiceId: "c-gold" } });
    expect(ok(tier, "c-silver")).toEqual({
      ok: true,
      value: { type: "Choice", choiceId: "c-silver" },
    });
    expect(ok(tier, "bronze")).toEqual({ ok: false, problem: "invalid" });
    expect(ok(field("Person"), "11111111-2222-4333-8444-555555555555")).toMatchObject({ ok: true });
    expect(ok(field("Person"), "carol")).toEqual({ ok: false, problem: "invalid" });
    expect(ok(field("Text"), "x".repeat(10_001))).toEqual({ ok: false, problem: "invalid" });
    expect(ok(field("Number"), "   ")).toEqual({ ok: true, value: null });
  });

  it("turns decimals into minor units and back", () => {
    expect(decimalToMinor("-12.3", 2)).toBe(-1230);
    expect(decimalToMinor("7", 0)).toBe(7);
    expect(decimalToMinor("1.234", 2)).toBeNull();
    expect(decimalToMinor("abc", 2)).toBeNull();
    expect(minorToDecimal(-1230, 2)).toBe("-12.30");
    expect(minorToDecimal(7, 0)).toBe("7");
  });

  it("gives each value back as the text its input shows", () => {
    expect(inputOfValue({ type: "Money", minor: 250050, currency: "USD" }, tier, context)).toEqual({
      value: "2500.50",
      currency: "USD",
    });
    expect(inputOfValue({ type: "Choice", choiceId: "c-silver" }, tier, context)).toEqual({
      value: "silver",
    });
    expect(inputOfValue({ type: "Choice", choiceId: "gone" }, tier, context)).toEqual({
      value: "",
    });
    expect(
      inputOfValue({ type: "Timestamp", at: "2026-11-02T14:30:00.000Z" }, tier, context),
    ).toEqual({ value: "2026-11-02T09:30" });
    expect(inputOfValue({ type: "Boolean", boolean: true }, tier, context)).toEqual({
      value: "true",
    });
    expect(inputOfValue({ type: "Number", number: 3 }, tier, context)).toEqual({ value: "3" });
    expect(inputOfValue({ type: "Date", date: "2026-11-02" }, tier, context)).toEqual({
      value: "2026-11-02",
    });
    expect(inputOfValue({ type: "Person", personId: "p1" }, tier, context)).toEqual({
      value: "p1",
    });
    expect(inputOfValue({ type: "URL", text: "https://a.b" }, tier, context)).toEqual({
      value: "https://a.b",
    });
    expect(localTimeIn("2027-01-01T04:30:00Z", "America/New_York")).toBe("2026-12-31T23:30");
  });
});

describe("required fields", () => {
  const po = field("Text", { key: "po_reference", label: "PO Reference", required: true });
  const seats = field("Number", { key: "seats" });

  it("needs every required field to create a row", () => {
    const missing = checkCustomFieldInputs([po, seats, tier], {}, "create", context);
    expect(missing.problems).toEqual({ po_reference: "required" });
    const blank = checkCustomFieldInputs(
      [po],
      { po_reference: { value: "  " } },
      "create",
      context,
    );
    expect(blank.problems).toEqual({ po_reference: "required" });
    const filled = checkCustomFieldInputs(
      [po, seats],
      { po_reference: { value: "PO-2207" }, seats: { value: "" }, stray: { value: "x" } },
      "create",
      context,
    );
    expect(filled.problems).toEqual({});
    expect([...filled.values]).toEqual([
      ["id-po_reference", { type: "Text", text: "PO-2207" }],
      ["id-seats", null],
    ]);
  });

  it("judges only the fields an update sends, and refuses clearing a required one", () => {
    expect(
      checkCustomFieldInputs([po, seats], { seats: { value: "4" } }, "update", context),
    ).toEqual({
      values: new Map([["id-seats", { type: "Number", number: 4 }]]),
      problems: {},
    });
    expect(
      checkCustomFieldInputs([po], { po_reference: { value: "" } }, "update", context).problems,
    ).toEqual({ po_reference: "required" });
    expect(
      checkCustomFieldInputs([seats], { seats: { value: "many" } }, "update", context).problems,
    ).toEqual({ seats: "invalid" });
  });
});

describe("reading values", () => {
  it("reads values per row and field in chunks of row ids", async () => {
    const ids = Array.from({ length: 160 }, (_, i) => `row-${i}`);
    const { db, calls } = fakeClient({
      "from:custom_field_values": [
        okResponse([
          {
            id: "v1",
            custom_field_definition_id: "c-tier-def",
            target_id: "row-1",
            ...EMPTY_ROW,
            value_choice_id: "c-gold",
          },
          {
            id: "v2",
            custom_field_definition_id: "unknown",
            target_id: "row-1",
            ...EMPTY_ROW,
            value_text: "ignored",
          },
          {
            id: "v3",
            custom_field_definition_id: "c-tier-def",
            target_id: "row-2",
            ...EMPTY_ROW,
          },
        ]),
        okResponse([]),
      ],
    });
    const result = await listCustomFieldValues(db, [{ ...tier, id: "c-tier-def" }], ids);
    expect(result.ok && Object.fromEntries(result.data)).toEqual({
      "row-1": { tier: { type: "Choice", choiceId: "c-gold" } },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.steps).toContainEqual(["in", ["target_id", ids.slice(0, 150)]]);
  });

  it("reads nothing without fields or rows, and reports a failed read", async () => {
    const { db, calls } = fakeClient({
      "from:custom_field_values": [errorResponse("XX000", "boom")],
    });
    expect(await listCustomFieldValues(db, [], ["a"])).toEqual({ ok: true, data: new Map() });
    expect(await listCustomFieldValues(db, [tier], [])).toEqual({ ok: true, data: new Map() });
    expect(calls).toHaveLength(0);
    expect((await listCustomFieldValues(db, [tier], ["a"])).ok).toBe(false);
  });
});

describe("writing values", () => {
  it("inserts new values, updates changed ones in place and soft deletes cleared ones", async () => {
    const { db, calls } = fakeClient({
      "from:custom_field_values": [
        okResponse([
          { id: "v-seats", custom_field_definition_id: "id-seats" },
          { id: "v-tier", custom_field_definition_id: "id-tier" },
        ]),
        okResponse(null),
        okResponse(null),
        okResponse(null),
      ],
    });
    const result = await writeCustomFieldValues(db, {
      orgId: "org-1",
      targetId: "prj-1",
      values: new Map<string, CustomFieldValue | null>([
        ["id-text", { type: "Text", text: "Dock 4" }],
        ["id-seats", { type: "Number", number: 1200 }],
        ["id-tier", null],
        ["id-missing", null],
      ]),
    });
    expect(result).toEqual({ ok: true, data: null });
    const [, insert, update, remove] = calls;
    expect(insert?.steps[0]).toEqual([
      "insert",
      [
        {
          org_id: "org-1",
          custom_field_definition_id: "id-text",
          target_id: "prj-1",
          ...EMPTY_ROW,
          value_text: "Dock 4",
        },
      ],
    ]);
    expect(update?.steps).toEqual([
      ["update", [{ ...EMPTY_ROW, value_number: 1200 }]],
      ["eq", ["id", "v-seats"]],
    ]);
    expect(remove?.steps[0]?.[0]).toBe("update");
    expect(remove?.steps[0]?.[1]).toEqual([{ deleted_at: expect.any(String) }]);
    expect(calls).toHaveLength(4);
  });

  it("stops at the database's refusal and names its rule", async () => {
    const { db } = fakeClient({
      "from:custom_field_values": [
        okResponse([{ id: "v-po", custom_field_definition_id: "id-po" }]),
        errorResponse(
          "XR001",
          "custom_value_required: PO Reference is required; change its value instead of removing it.",
          "custom_value_required",
        ),
      ],
    });
    const result = await writeCustomFieldValues(db, {
      orgId: "org-1",
      targetId: "prj-1",
      values: new Map([["id-po", null]]),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "custom_value_required" },
    });
  });

  it("writes nothing for no values and reports a failed read of the current ones", async () => {
    const { db, calls } = fakeClient({
      "from:custom_field_values": [errorResponse("XX000", "boom")],
    });
    expect(
      await writeCustomFieldValues(db, { orgId: "o", targetId: "t", values: new Map() }),
    ).toEqual({
      ok: true,
      data: null,
    });
    expect(calls).toHaveLength(0);
    const failed = await writeCustomFieldValues(db, {
      orgId: "o",
      targetId: "t",
      values: new Map([["id-x", null]]),
    });
    expect(failed.ok).toBe(false);
  });
});

describe("filtering rows by their values", () => {
  const seats = field("Number", { key: "seats" });
  const name = field("Text", { key: "dock" });
  const hidden = field("Text", { key: "notes", filterable: false });
  const when = field("Timestamp", { key: "load_in" });
  const day = field("Date", { key: "opening" });
  const flag = field("Boolean", { key: "union" });
  const owner = field("Person", { key: "owner" });
  const fee = field("Money", { key: "fee" });
  const fields = [seats, name, hidden, when, day, flag, owner, fee, tier];
  const match = (
    db: Parameters<typeof matchCustomFieldConditions>[0],
    conditions: Parameters<typeof matchCustomFieldConditions>[1]["conditions"],
  ) =>
    matchCustomFieldConditions(db, {
      orgId: "org-1",
      fields,
      conditions,
      timeZone: "America/New_York",
    });

  it("offers each data type its operators", () => {
    expect(operatorsFor("Text")[0]).toBe("contains");
    expect(operatorsFor("Money")).toContain("gte");
    expect(operatorsFor("Timestamp")).toEqual(["eq", "gte", "lte", "is_null"]);
    expect(operatorsFor("Boolean")).toEqual(["eq"]);
    expect(operatorsFor("Person")).toEqual(["eq", "ne", "is_null"]);
  });

  it("keeps the rows every condition includes on the field's typed column", async () => {
    const { db, calls } = fakeClient({
      "from:custom_field_values": [
        okResponse([{ target_id: "a" }, { target_id: "b" }]),
        okResponse([{ target_id: "b" }, { target_id: "c" }]),
      ],
    });
    const result = await match(db, [
      { key: "seats", operator: "gte", value: "1,000" },
      { key: "dock", operator: "contains", value: "50%_off" },
    ]);
    expect(result.ok).toBe(true);
    const keep = result.ok ? result.data : null;
    expect(["a", "b", "c", "d"].filter((id) => keep?.(id))).toEqual(["b"]);
    expect(calls[0]?.steps).toContainEqual(["gte", ["value_number", 1000]]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["custom_field_definition_id", "id-seats"]]);
    expect(calls[1]?.steps).toContainEqual(["ilike", ["value_text", "%50\\%\\_off%"]]);
  });

  it("lets rows without a value pass is not and is empty", async () => {
    const { db, calls } = fakeClient({
      "from:custom_field_values": [
        okResponse([{ target_id: "gold-row" }]),
        okResponse([{ target_id: "gold-row" }, { target_id: "has-owner" }]),
      ],
    });
    const result = await match(db, [
      { key: "tier", operator: "ne", value: "gold" },
      { key: "owner", operator: "is_null", value: "true" },
    ]);
    const keep = result.ok ? result.data : null;
    expect(["gold-row", "has-owner", "plain"].filter((id) => keep?.(id))).toEqual(["plain"]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["value_choice_id", "c-gold"]]);
    expect(calls[1]?.steps).toContainEqual(["not", ["value_person_id", "is", null]]);
  });

  it("reads matching ids page by page", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ target_id: `r${i}` }));
    const { db, calls } = fakeClient({
      "from:custom_field_values": [okResponse(page), okResponse([{ target_id: "last" }])],
    });
    const result = await match(db, [{ key: "union", operator: "eq", value: "true" }]);
    const keep = result.ok ? result.data : null;
    expect(keep?.("last")).toBe(true);
    expect(keep?.("r999")).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.steps).toContainEqual(["range", [1000, 1999]]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["value_boolean", true]]);
  });

  const currencies = okResponse([
    { currency_code: "USD", minor_unit_exponent: 2 },
    { currency_code: "JPY", minor_unit_exponent: 0 },
    { currency_code: "KWD", minor_unit_exponent: 3 },
    { currency_code: "KRW", minor_unit_exponent: 0 },
  ]);

  it("reads a timestamp filter's day on the org's calendar and money in major units", async () => {
    const { db, calls } = fakeClient({
      "from:currencies": [currencies],
      "from:custom_field_values": [okResponse([]), okResponse([]), okResponse([]), okResponse([])],
    });
    await match(db, [
      { key: "load_in", operator: "eq", value: "2026-11-02" },
      { key: "load_in", operator: "lte", value: "2026-11-02" },
      { key: "opening", operator: "gte", value: "2026-11-02" },
      { key: "fee", operator: "lt", value: "2500.50" },
    ]);
    expect(calls[1]?.steps).toContainEqual([
      "gte",
      ["value_timestamp", "2026-11-02T05:00:00.000Z"],
    ]);
    expect(calls[1]?.steps).toContainEqual(["lt", ["value_timestamp", "2026-11-03T05:00:00.000Z"]]);
    expect(calls[2]?.steps).toContainEqual(["lt", ["value_timestamp", "2026-11-03T05:00:00.000Z"]]);
    expect(calls[3]?.steps).toContainEqual(["gte", ["value_date", "2026-11-02"]]);
    expect(calls[0]?.target).toBe("from:currencies");
    expect(calls[4]?.steps).toContainEqual([
      "or",
      [
        "and(value_currency.not.in.(JPY,KRW,KWD),value_money_minor.lt.250050)," +
          "and(value_currency.in.(JPY,KRW),value_money_minor.lte.2500)," +
          "and(value_currency.in.(KWD),value_money_minor.lt.2500500)",
      ],
    ]);
  });

  it("scales a money amount by each value's currency and rounds a finer bound down", async () => {
    const { db, calls } = fakeClient({
      "from:currencies": [currencies, currencies],
      "from:custom_field_values": [okResponse([]), okResponse([])],
    });
    await match(db, [{ key: "fee", operator: "eq", value: "100" }]);
    expect(calls[1]?.steps).toContainEqual([
      "or",
      [
        "and(value_currency.not.in.(JPY,KRW,KWD),value_money_minor.eq.10000)," +
          "and(value_currency.in.(JPY,KRW),value_money_minor.eq.100)," +
          "and(value_currency.in.(KWD),value_money_minor.eq.100000)",
      ],
    ]);
    // 0.555 is exact only in dinars; yen hold none of it, and dollars round down to 0.55.
    await match(db, [{ key: "fee", operator: "gte", value: "-0.555" }]);
    expect(calls[3]?.steps).toContainEqual([
      "or",
      [
        "and(value_currency.not.in.(JPY,KRW,KWD),value_money_minor.gt.-56)," +
          "and(value_currency.in.(JPY,KRW),value_money_minor.gt.-1)," +
          "and(value_currency.in.(KWD),value_money_minor.gte.-555)",
      ],
    ]);
  });

  it("ignores unknown and unfilterable fields, and keeps no row for a value that cannot match", async () => {
    const { db, calls } = fakeClient({ "from:currencies": [currencies] });
    expect(
      await match(db, [
        { key: "nope", operator: "eq", value: "x" },
        { key: "notes", operator: "eq", value: "x" },
      ]),
    ).toEqual({ ok: true, data: null });
    const none = await match(db, [{ key: "seats", operator: "gt", value: "lots" }]);
    expect(none.ok && none.data?.("anything")).toBe(false);
    for (const condition of [
      { key: "tier", operator: "eq" as const, value: "bronze" },
      { key: "owner", operator: "eq" as const, value: "carol" },
      { key: "union", operator: "eq" as const, value: "maybe" },
      { key: "opening", operator: "contains" as const, value: "2026" },
      { key: "load_in", operator: "contains" as const, value: "2026-11-02" },
      { key: "dock", operator: "gt" as const, value: "b" },
      { key: "fee", operator: "eq" as const, value: "free" },
    ]) {
      const result = await match(db, [condition]);
      expect(result.ok && result.data?.("anything"), condition.key).toBe(false);
    }
    // Only the money condition read anything: the currencies' exponents.
    expect(calls.map((c) => c.target)).toEqual(["from:currencies"]);
  });

  it("reports a failed read", async () => {
    const { db } = fakeClient({ "from:custom_field_values": [errorResponse("XX000", "boom")] });
    expect((await match(db, [{ key: "seats", operator: "eq", value: "4" }])).ok).toBe(false);
  });
});
