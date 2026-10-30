/**
 * xos/no-restated-enums (Section 3.15 single source of truth).
 *
 * A state, kind or status that the database defines as an enum has one home: the enum, as the
 * generated `Constants` and `Database["…"]["Enums"]` of @xos/data/database.types, or one list of
 * @xos/data/enums in code a browser loads (ADR 0123). Code that writes the values out again drifts
 * the day a migration adds or renames one.
 * The rule reports a string-literal union type or an array of string literals whose values are
 * exactly the values of one database enum, in any order. A subset is not reported: a list of the
 * states a screen offers, or the terminal states, is a decision of its own.
 * Enum values come from the `enums` option, or by default from packages/data/src/database.types.ts.
 */

import { databaseEnums } from "./database-enums.mjs";

/** Order-insensitive key for a set of values. */
function setKey(values) {
  return JSON.stringify([...new Set(values)].sort());
}

/** Enum names by the key of their value set; enums of fewer than two values are left out. */
function indexEnums(enums) {
  const index = new Map();
  for (const [name, values] of Object.entries(enums)) {
    if (new Set(values).size < 2) continue;
    const key = setKey(values);
    index.set(key, [...(index.get(key) ?? []), name]);
  }
  return index;
}

/** `Constants.app.Enums.state` for `app.state`. */
function constantsPath(name) {
  const [schema, enumName] = name.split(".");
  return `Constants.${schema}.Enums.${enumName}`;
}

/** `exportFormat` for `app.export_format`, `xpmsRefusal` for `xpms.refusal`, as @xos/data/enums names them. */
function enumsExport(name) {
  const [schema, enumName] = name.split(".");
  const camel = enumName.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  return schema === "app" ? camel : `${schema}${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

/** @type {import("eslint").Rule.RuleModule} */
export const noRestatedEnums = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow string-literal unions and arrays that restate a database enum; read it from @xos/data.",
    },
    schema: [
      {
        type: "object",
        properties: {
          enums: {
            type: "object",
            additionalProperties: { type: "array", items: { type: "string" } },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      restated:
        'These values restate the database enum {{names}}. Read them from {{path}} of @xos/data/database.types, enums.{{camel}} of @xos/data/enums in code a browser loads, or the Database[…]["Enums"] type.',
    },
  },
  create(context) {
    const index = indexEnums(context.options[0]?.enums ?? databaseEnums());

    function check(node, values) {
      if (values.length < 2) return;
      const names = index.get(setKey(values));
      if (!names) return;
      context.report({
        node,
        messageId: "restated",
        data: {
          names: names.join(", "),
          path: constantsPath(names[0]),
          camel: enumsExport(names[0]),
        },
      });
    }

    return {
      TSUnionType(node) {
        if (node.parent?.type === "TSUnionType") return;
        const values = [];
        const collect = (union) => {
          for (const member of union.types) {
            if (member.type === "TSUnionType") collect(member);
            else if (member.type === "TSLiteralType" && typeof member.literal.value === "string") {
              values.push(member.literal.value);
            }
          }
        };
        collect(node);
        check(node, values);
      },
      ArrayExpression(node) {
        const values = [];
        for (const element of node.elements) {
          if (element?.type !== "Literal" || typeof element.value !== "string") return;
          values.push(element.value);
        }
        check(node, values);
      },
    };
  },
};

/**
 * Flat config block that turns the rule on for TypeScript sources. Generated files restate enums by
 * design (database.types and enums.generated.ts themselves, the SDK types generated from the OpenAPI
 * document), and tests assert on literal values.
 */
export const restatedEnums = [
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    ignores: [
      "**/test/**",
      "**/tests/**",
      "**/e2e/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/database.types.ts",
      "**/*.generated.ts",
      "**/*.generated.tsx",
      "**/generated/**",
    ],
    rules: { "xos/no-restated-enums": "error" },
  },
];
