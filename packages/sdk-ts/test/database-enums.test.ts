import { databaseEnums } from "@xos/config/database-enums";
import { describe, expect, it } from "vitest";
import { REFUSAL_KINDS } from "../src/runtime/errors.ts";
import { FILTER_OPERATORS } from "../src/runtime/types.ts";

/**
 * The SDK is published on its own and cannot read @xos/data's Constants (ADR 0123). Its lists of
 * database enum values are held here to the same values as their enums, in any order.
 */
const lists: readonly (readonly [string, readonly string[]])[] = [
  ["xpms.refusal", REFUSAL_KINDS],
  ["app.filter_operator", FILTER_OPERATORS],
];

describe("lists that mirror a database enum", () => {
  const enums = databaseEnums();
  it.each(lists)("%s", (name, values) => {
    expect([...values].sort()).toEqual([...(enums[name] ?? [])].sort());
  });
});
