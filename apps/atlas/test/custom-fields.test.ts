import { describe, expect, it } from "vitest";
import type { CustomField } from "@xos/data/custom-fields";
import {
  currencyExponent,
  customFieldColumns,
  formatCustomFieldValue,
  type CustomFieldFormatContext,
} from "@/components/custom-fields/format";
import {
  choiceLabelKey,
  choiceOf,
  choicesFor,
  filterTargets,
  needsValue,
  toCondition,
} from "@/components/views/filter-model";
import {
  CUSTOM_FIELD_SHOWN,
  customFieldCurrencyName,
  customFieldInputName,
  customFieldInputsOf,
} from "@/lib/custom-fields/names";
import type { CustomFieldListView } from "@/lib/custom-fields/types";
import {
  conditionParam,
  conditionsOf,
  customConditionsOf,
  fieldParamKey,
  filterParam,
  isConditionOperator,
  matchesShown,
  parseCondition,
  splitFilterParam,
} from "@/lib/views/conditions";
import { canonicalQuery, currentQuery, queryToView, viewToQuery } from "@/lib/views/query";

/**
 * Custom fields on Atlas pages and the Add filter control (A117, RRR-162): the URL grammar of filter conditions,
 * saved views keeping their operators, the FormData names of custom field inputs, display text of every value
 * type, and what the filter editor offers.
 */

function field(dataType: CustomField["dataType"], extra: Partial<CustomField> = {}): CustomField {
  const key = extra.key ?? dataType.toLowerCase();
  return {
    id: `id-${key}`,
    targetTable: "app.records",
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
  label: "Tier",
  choices: [{ id: "c-gold", key: "gold", label: "Gold" }],
});

describe("filter conditions in the query string", () => {
  it("reads custom field and declared field conditions with their operators", () => {
    const search = new URLSearchParams(
      "cf.tier=gold&cf.seats.gte=100&f.vendor.contains=acme&f.due_on.is_null=true&project=NWL&cf.Bad=1&cf.x.nope=2&cf.empty=",
    );
    expect(conditionsOf(search)).toEqual([
      { scope: "custom", key: "tier", operator: "eq", value: "gold" },
      { scope: "custom", key: "seats", operator: "gte", value: "100" },
      { scope: "field", key: "vendor", operator: "contains", value: "acme" },
      { scope: "field", key: "due_on", operator: "is_null", value: "true" },
    ]);
    expect(
      customConditionsOf({ "cf.tier": ["gold", "silver"], "f.vendor": "acme", view: "table" }),
    ).toEqual([{ key: "tier", operator: "eq", value: "gold" }]);
    expect(parseCondition("cf.tier", "x".repeat(1001))).toBeNull();
    expect(parseCondition("tier", "gold")).toBeNull();
  });

  it("writes a condition back as the parameter it was read from", () => {
    for (const name of ["cf.tier", "cf.seats.gte", "f.vendor.contains", "f.due_on.is_null"]) {
      const condition = parseCondition(name, "v");
      expect(condition && conditionParam(condition)).toEqual([name, "v"]);
    }
    expect(splitFilterParam("cf.seats.lte")).toEqual({ field: "cf.seats", operator: "lte" });
    expect(splitFilterParam("project.gte")).toEqual({ field: "project.gte", operator: "eq" });
    expect(splitFilterParam("project")).toEqual({ field: "project", operator: "eq" });
    expect(filterParam("cf.seats", "eq")).toBe("cf.seats");
    expect(isConditionOperator("in")).toBe(false);
    expect(fieldParamKey("dueOn")).toBe("due_on");
  });

  it("matches a declared field on the text the page shows", () => {
    const c = (operator: Parameters<typeof matchesShown>[1]["operator"], value: string) => ({
      scope: "field" as const,
      key: "vendor",
      operator,
      value,
    });
    expect(matchesShown("Acme Rigging", c("contains", "acme"))).toBe(true);
    expect(matchesShown("Acme Rigging", c("eq", "acme rigging"))).toBe(true);
    expect(matchesShown("Acme Rigging", c("ne", "acme rigging"))).toBe(false);
    expect(matchesShown("", c("is_null", "true"))).toBe(true);
    expect(matchesShown("Acme", c("is_null", "true"))).toBe(false);
    expect(matchesShown("Acme", c("is_null", "false"))).toBe(true);
    expect(matchesShown("$2,500.00", c("gte", "2000"))).toBe(true);
    expect(matchesShown("12", c("lt", "10"))).toBe(false);
    expect(matchesShown("12", c("gt", "10"))).toBe(true);
    expect(matchesShown("12", c("lte", "12"))).toBe(true);
    expect(matchesShown("", c("gt", "1"))).toBe(false);
  });
});

describe("saved views keep the Add filter control's conditions", () => {
  it("saves each condition's field, operator and value, and opens the same query again", () => {
    const search = new URLSearchParams(
      "view=table&cf.tier=gold&cf.seats.gte=100&f.vendor.contains=acme&cf.owner.is_null=false&peek=abc",
    );
    const view = queryToView(search, "table");
    expect(view.filters).toEqual([
      { field: "cf.tier", operator: "eq", value: "gold" },
      { field: "cf.seats", operator: "gte", value: "100" },
      { field: "f.vendor", operator: "contains", value: "acme" },
      { field: "cf.owner", operator: "is_null", value: "false" },
    ]);
    const reopened = viewToQuery(view, ["table", "list"]);
    expect(canonicalQuery(reopened)).toBe(currentQuery(search, "table", ["table", "list"]));
    expect(new URLSearchParams(reopened).get("cf.seats.gte")).toBe("100");
  });

  it("reads a saved filter the control did not write as eq, and an is_null without a value as is empty", () => {
    expect(
      viewToQuery(
        {
          viewType: "Table",
          searchText: null,
          groupByField: null,
          filters: [
            { field: "project", operator: "in", value: "NWL" },
            { field: "cf.owner", operator: "is_null", value: null },
            { field: "cf.tier", value: "gold" },
          ],
          sorts: [],
        },
        ["table"],
      ),
    ).toBe("view=table&project=NWL&cf.owner.is_null=true&cf.tier=gold");
  });
});

describe("custom field inputs in a form", () => {
  it("names each input after its field and reads them back by key", () => {
    const form = new FormData();
    form.set(CUSTOM_FIELD_SHOWN, "1");
    form.set(customFieldInputName("po_reference"), "PO-2207");
    form.set(customFieldInputName("fee"), "2500");
    form.set(customFieldCurrencyName("fee"), "USD");
    form.set("cf.Bad", "x");
    form.set("name", "Dock");
    expect(customFieldInputsOf(form)).toEqual({
      po_reference: { value: "PO-2207" },
      fee: { value: "2500", currency: "USD" },
    });
  });
});

describe("custom field values as display text", () => {
  const context: CustomFieldFormatContext = {
    format: {
      dateTime: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en-US", options).format(value),
      number: (value: number | bigint, options?: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat("en-US", options).format(value),
    } as CustomFieldFormatContext["format"],
    yes: "Yes",
    no: "No",
    people: { p1: "Carol Diaz" },
    someone: "A former member",
    timeZone: "America/New_York",
  };

  it("shows every data type in the viewer's locale", () => {
    const show = (value: Parameters<typeof formatCustomFieldValue>[1]) =>
      formatCustomFieldValue(tier, value, context);
    expect(show({ type: "Text", text: "Dock 4" })).toBe("Dock 4");
    expect(show({ type: "Number", number: 1200.5 })).toBe("1,200.5");
    expect(show({ type: "Money", minor: 250050, currency: "USD" })).toBe("$2,500.50");
    expect(show({ type: "Money", minor: 2500, currency: "JPY" })).toBe("¥2,500");
    expect(show({ type: "Date", date: "2026-11-02" })).toBe("Nov 2, 2026");
    expect(show({ type: "Timestamp", at: "2026-11-02T14:30:00.000Z" })).toMatch(
      /^Nov 2, 2026, 9:30\sAM$/,
    );
    expect(show({ type: "Boolean", boolean: true })).toBe("Yes");
    expect(show({ type: "Boolean", boolean: false })).toBe("No");
    expect(show({ type: "Choice", choiceId: "c-gold" })).toBe("Gold");
    expect(show({ type: "Choice", choiceId: "gone" })).toBe("");
    expect(show({ type: "Person", personId: "p1" })).toBe("Carol Diaz");
    expect(show({ type: "Person", personId: "p2" })).toBe("A former member");
    expect(currencyExponent("BHD")).toBe(3);
    expect(currencyExponent("NOT")).toBe(2);
  });

  it("turns a list's filterable fields into table columns and cells", () => {
    const view: CustomFieldListView = {
      table: "app.records",
      fields: [tier, field("Number", { key: "seats", label: "Seats" })],
      values: { r1: { tier: { type: "Choice", choiceId: "c-gold" } } },
      people: {},
      timeZone: "UTC",
    };
    const columns = customFieldColumns(view, context);
    expect(columns.columns).toEqual([
      { key: "cf.tier", label: "Tier" },
      { key: "cf.seats", label: "Seats" },
    ]);
    expect(columns.cells("r1")).toEqual({ "cf.tier": "Gold", "cf.seats": null });
    expect(columns.cells("r2")).toEqual({ "cf.tier": null, "cf.seats": null });
    expect(customFieldColumns(null, context).columns).toEqual([]);
  });
});

describe("what the Add filter control offers", () => {
  const view: CustomFieldListView = {
    table: "app.records",
    fields: [
      tier,
      field("Boolean", { key: "union", label: "Union" }),
      field("Person", { key: "owner", label: "Owner" }),
      field("Timestamp", { key: "load_in", label: "Load in" }),
      field("Text", { key: "notes", label: "Notes", filterable: false }),
    ],
    values: {},
    people: { p2: "Zoe Park", p1: "Ana Ruiz" },
    timeZone: "UTC",
  };

  it("offers the page's fields, then the filterable custom fields, each with its conditions", () => {
    const targets = filterTargets(
      [{ key: "vendor", label: "Vendor", options: [{ value: "Acme", label: "Acme" }] }],
      view,
      { yes: "Yes", no: "No" },
    );
    expect(targets.map((t) => [t.scope, t.key, t.kind])).toEqual([
      ["field", "vendor", "text"],
      ["custom", "tier", "choice"],
      ["custom", "union", "boolean"],
      ["custom", "owner", "person"],
      ["custom", "load_in", "timestamp"],
    ]);
    const [vendor, choice, union, owner, loadIn] = targets;
    expect(choice?.options).toEqual([{ value: "gold", label: "Gold" }]);
    expect(union?.options?.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(owner?.options?.map((o) => o.label)).toEqual(["Ana Ruiz", "Zoe Park"]);
    expect(vendor && choicesFor(vendor)).toEqual(["contains", "eq", "ne", "empty", "filled"]);
    expect(loadIn && choicesFor(loadIn)).toEqual(["eq", "gte", "lte", "empty", "filled"]);
    expect(filterTargets([], null, { yes: "Yes", no: "No" })).toEqual([]);
  });

  it("maps the editor's choices to conditions and back", () => {
    const [choice] = filterTargets([], view, { yes: "Yes", no: "No" });
    if (!choice) throw new Error("no target");
    expect(toCondition(choice, "eq", " gold ")).toEqual({
      scope: "custom",
      key: "tier",
      operator: "eq",
      value: "gold",
    });
    const empty = toCondition(choice, "empty", "");
    expect(empty).toEqual({ scope: "custom", key: "tier", operator: "is_null", value: "true" });
    expect(choiceOf(empty)).toBe("empty");
    expect(choiceOf(toCondition(choice, "filled", ""))).toBe("filled");
    expect(needsValue("empty")).toBe(false);
    expect(needsValue("gte")).toBe(true);
    expect(choiceLabelKey("date", "gte")).toBe("onOrAfter");
    expect(choiceLabelKey("timestamp", "lt")).toBe("before");
    expect(choiceLabelKey("number", "gt")).toBe("moreThan");
    expect(choiceLabelKey("text", "eq")).toBe("is");
    expect(choiceLabelKey("date", "eq")).toBe("on");
    expect(choiceLabelKey("money", "lte")).toBe("atMost");
    expect(choiceLabelKey("choice", "ne")).toBe("isNot");
    expect(choiceLabelKey("text", "filled")).toBe("filled");
  });
});
