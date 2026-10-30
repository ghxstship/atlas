import { readFileSync } from "node:fs";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { databaseEnums, enumsFromTypes } from "../eslint/database-enums.mjs";
import { noRestatedEnums } from "../eslint/no-restated-enums.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const enums = {
  "app.shift_state": ["Draft", "Published", "Accepted", "Canceled"],
  "app.approval_decision": ["Approved", "Rejected"],
  "app.swap_state": ["Proposed", "Approved", "Rejected", "Canceled"],
  "app.time_off_state": ["Proposed", "Approved", "Rejected", "Canceled"],
  "app.single": ["Only"],
  "xpms.refusal": ["NO_ANSWER", "UNRATIFIED", "REFUSE"],
};
const options = [{ enums }];

tester.run("xos/no-restated-enums", noRestatedEnums, {
  valid: [
    { code: `const s = z.enum(Constants.app.Enums.shift_state);`, options },
    { code: `type S = Database["app"]["Enums"]["shift_state"];`, options },
    // A subset is a decision of its own: the states a screen offers, or the terminal ones.
    { code: `const open = ["Draft", "Published"] as const;`, options },
    { code: `type Done = "Accepted" | "Canceled";`, options },
    // A superset is not the enum either.
    { code: `const all = ["Draft", "Published", "Accepted", "Canceled", "Archived"];`, options },
    // A one-value enum is never matched.
    { code: `const one = ["Only"];`, options },
    { code: `type One = "Only" | "Other";`, options },
    // Arrays that mix in other elements, and unions of other types, are not lists of values.
    { code: `const mixed = ["Approved", rejected];`, options },
    { code: `const spread = [...states, "Approved"];`, options },
    { code: `type T = "Approved" | number;`, options },
    { code: `const nums = [1, 2];`, options },
  ],
  invalid: [
    {
      code: `const SHIFT_STATE = z.enum(["Draft", "Published", "Accepted", "Canceled"]);`,
      options,
      errors: [
        {
          messageId: "restated",
          data: {
            names: "app.shift_state",
            path: "Constants.app.Enums.shift_state",
            camel: "shiftState",
          },
        },
      ],
    },
    {
      // Order does not matter.
      code: `const KINDS = ["Canceled", "Draft", "Accepted", "Published"] as const;`,
      options,
      errors: [{ messageId: "restated" }],
    },
    {
      code: `type Decision = "Approved" | "Rejected";`,
      options,
      errors: [
        {
          messageId: "restated",
          data: {
            names: "app.approval_decision",
            path: "Constants.app.Enums.approval_decision",
            camel: "approvalDecision",
          },
        },
      ],
    },
    {
      // Null and undefined members are left out of the comparison.
      code: `let d: "Rejected" | "Approved" | null = null;`,
      options,
      errors: [{ messageId: "restated" }],
    },
    {
      // A nested union is reported once, at the outermost union.
      code: `type R = ("NO_ANSWER" | "UNRATIFIED") | "REFUSE";`,
      options,
      errors: [
        {
          messageId: "restated",
          data: {
            names: "xpms.refusal",
            path: "Constants.xpms.Enums.refusal",
            camel: "xpmsRefusal",
          },
        },
      ],
    },
    {
      // Two enums with the same values are both named.
      code: `const states = new Set(["Proposed", "Approved", "Rejected", "Canceled"]);`,
      options,
      errors: [
        {
          messageId: "restated",
          data: {
            names: "app.swap_state, app.time_off_state",
            path: "Constants.app.Enums.swap_state",
            camel: "swapState",
          },
        },
      ],
    },
    {
      code: `const el = <Select options={["Approved", "Rejected"].map((d) => ({ value: d }))} />;`,
      filename: "form.tsx",
      options,
      errors: [{ messageId: "restated" }],
    },
  ],
});

describe("database enum lists", () => {
  it("reads single-line and wrapped arrays from the Constants block", () => {
    const source = [
      'export type Database = { app: { Enums: { kind: "A" | "B" } } };',
      "export const Constants = {",
      "  api_external: {",
      "    Enums: {},",
      "  },",
      "  app: {",
      "    Enums: {",
      '      kind: ["A", "B"],',
      "      long_kind: [",
      '        "First \\"Quoted\\"",',
      '        "Second",',
      "      ],",
      "    },",
      "  },",
      "  xpms: {",
      "    Enums: {",
      '      refusal: ["NO_ANSWER", "REFUSE"],',
      "    },",
      "  },",
      "} as const;",
    ].join("\n");
    expect(enumsFromTypes(source)).toEqual({
      "app.kind": ["A", "B"],
      "app.long_kind": ['First "Quoted"', "Second"],
      "xpms.refusal": ["NO_ANSWER", "REFUSE"],
    });
  });

  it("refuses a source without a Constants block", () => {
    expect(() => enumsFromTypes("export type Database = {};")).toThrow(/Constants/);
  });

  it("reads every enum of the repository's generated types", () => {
    const source = readFileSync(
      new URL("../../data/src/database.types.ts", import.meta.url),
      "utf8",
    );
    const all = databaseEnums();
    // One Constants entry per enum of the Database type's Enums blocks.
    const declared = [...source.matchAll(/^ {6}(\w+): \[/gm)].length;
    expect(Object.keys(all)).toHaveLength(declared);
    expect(all["xpms.refusal"]).toEqual(["NO_ANSWER", "UNRATIFIED", "REFUSE"]);
    expect(Object.values(all).every((values) => values.length > 0)).toBe(true);
  });
});
