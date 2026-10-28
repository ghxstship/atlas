import { databaseEnums } from "@xos/config/database-enums";
import { describe, expect, it } from "vitest";
import type { AuroraSuggestion } from "../src/client.ts";
import { FILTER_OPERATORS } from "../src/features/filters.ts";
import { AI_FEATURES } from "../src/model.ts";

/**
 * This package sits below @xos/data, so its lists of database enum values cannot read Constants
 * (ADR 0120). Each is held here to the same values as its enum, in any order. A Record over a union
 * type must name each member once, so its keys are the union's members.
 */
const suggestionStates: Record<AuroraSuggestion["suggestion_state"], true> = {
  Proposed: true,
  Confirmed: true,
  Applied: true,
  Rejected: true,
  Expired: true,
};

const lists: readonly (readonly [string, readonly string[]])[] = [
  ["app.ai_suggestion_state", Object.keys(suggestionStates)],
  ["app.filter_operator", FILTER_OPERATORS],
  ["app.ai_feature", AI_FEATURES],
];

describe("lists that mirror a database enum", () => {
  const enums = databaseEnums();
  it.each(lists)("%s", (name, values) => {
    expect([...values].sort()).toEqual([...(enums[name] ?? [])].sort());
  });
});
