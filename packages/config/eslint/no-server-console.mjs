/**
 * Server code logs through the app's redacting logger (`lib/observability.ts`), never the console:
 * a console line reaches the platform log and the log drain as it is, with whatever email, token or
 * error detail it carries (A69-012, ADR 0025). A module whose directive prologue says "use client"
 * runs in the browser, where the console is the viewer's own, and may use it.
 */

/** Whether the module's directive prologue holds "use client". */
function isClientModule(program) {
  for (const statement of program.body) {
    if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string") break;
    if (statement.directive === "use client") return true;
  }
  return false;
}

/** @type {import("eslint").Rule.RuleModule} */
export const noServerConsole = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the console in server code; log through the app's redacting logger instead.",
    },
    schema: [],
    messages: {
      console:
        "console.{{method}} in server code skips the redactor. Use observability.logger from @/lib/observability (A69-012).",
    },
  },
  create(context) {
    if (isClientModule(context.sourceCode.ast)) return {};
    return {
      MemberExpression(node) {
        if (node.object.type !== "Identifier" || node.object.name !== "console") return;
        const variable = context.sourceCode
          .getScope(node)
          .references.find((reference) => reference.identifier === node.object)?.resolved;
        if (variable && variable.defs.length > 0) return;
        const method =
          node.property.type === "Identifier" && !node.computed ? node.property.name : "[]";
        context.report({ node, messageId: "console", data: { method } });
      },
    };
  },
};

/**
 * Flat config block for an app's server code. Tests, end-to-end specs and scripts print to the
 * console on purpose and are exempt.
 */
export const serverConsole = [
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    ignores: [
      "**/test/**",
      "**/tests/**",
      "**/e2e/**",
      "**/scripts/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.config.ts",
      "**/*.config.mts",
    ],
    rules: { "xos/no-server-console": "error" },
  },
];
