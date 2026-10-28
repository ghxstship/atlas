// @vitest-environment node
import { databaseEnums } from "@xos/config/database-enums";
import { describe, expect, it } from "vitest";
import type { RefusalNoticeProps } from "../src/types.ts";

/**
 * The native design system sits below @xos/data and cannot read its Constants (ADR 0120). Its copies
 * of database enum values are held here to the same values as their enums, in any order. A Record
 * over a union type must name each member once, so its keys are the union's members.
 */
const outcomes: Record<RefusalNoticeProps["outcome"], true> = {
  NO_ANSWER: true,
  UNRATIFIED: true,
  REFUSE: true,
};

describe("lists that mirror a database enum", () => {
  it("xpms.refusal", () => {
    expect(Object.keys(outcomes).sort()).toEqual(
      [...(databaseEnums()["xpms.refusal"] ?? [])].sort(),
    );
  });
});
