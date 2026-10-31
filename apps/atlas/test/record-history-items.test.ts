import type { HistoryEvent } from "@xos/data/field-history";
import { describe, expect, it } from "vitest";
import {
  recordHistoryItems,
  type RecordHistoryWording,
} from "../components/work/record-history-items";

/**
 * A record's kind attributes in its field history (A131, ADR 0090 section 6): an amount reads in the
 * currency its extension row held at that event, and as so many minor units when that currency is
 * unknown, never as a bare number under the attribute's label.
 */
const t = (key: string, values?: Record<string, string | number>) =>
  values ? `<${key} ${JSON.stringify(values)}>` : `<${key}>`;

function wording(extension: RecordHistoryWording["extension"]): RecordHistoryWording {
  return {
    t,
    locale: "en-US",
    when: (iso) => `instant ${iso}`,
    at: (iso) => `at ${iso}`,
    number: (n) => String(n),
    day: (d) => `day ${d}`,
    names: {},
    phases: [],
    fields: [
      { column: "value_minor", type: "money", currencyColumn: "currency_code" },
      { column: "currency_code", type: "text" },
    ],
    extension,
    currencies: [
      { code: "USD", exponent: 2 },
      { code: "JPY", exponent: 0 },
    ],
  };
}

function edit(id: string, changes: HistoryEvent["changes"]): HistoryEvent {
  return {
    id,
    at: "2027-06-10T14:00:00Z",
    actorId: null,
    actorName: "Carol Nguyen",
    operation: "update",
    changes,
  };
}

const change = (field: string, before: number | string, after: number | string) => ({
  field,
  before,
  after,
  masked: false,
});

describe("record history attributes", () => {
  it("words each event's amounts in the currency the extension row held then", () => {
    const items = recordHistoryItems(
      [
        edit("e2", [change("attributes.value_minor", 1000, 2000)]),
        edit("e1", [
          change("attributes.value_minor", 80000, 1000),
          change("attributes.currency_code", "USD", "JPY"),
        ]),
      ],
      wording({ value_minor: 2000, currency_code: "JPY" }),
    );
    const value = (id: string) =>
      items.find((i) => i.id === id)?.rows.find((r) => r.field === "<work.extension.value_minor>");
    expect(value("e2")).toMatchObject({ before: "¥1,000", after: "¥2,000" });
    expect(value("e1")).toMatchObject({ before: "$800.00", after: "¥1,000" });
  });

  it("says so many minor units when the currency is unknown", () => {
    const items = recordHistoryItems(
      [edit("e1", [change("attributes.value_minor", 40000, 80000)])],
      wording({ value_minor: 80000, currency_code: null }),
    );
    expect(items[0]?.rows[0]).toMatchObject({
      before: '<collab.history.minorUnits {"amount":"40000"}>',
      after: '<collab.history.minorUnits {"amount":"80000"}>',
    });
  });
});
