import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import { noServerConsole } from "../eslint/no-server-console.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

// A69-012: a console line in server code reaches the log drain unredacted.
tester.run("xos/no-server-console", noServerConsole, {
  valid: [
    { code: `observability.logger.error("save failed", { error });` },
    { code: `"use client";\nconsole.error(error);` },
    { code: `"use strict";\n"use client";\nconsole.warn("x");` },
    { code: `const console = { error() {} };\nconsole.error("shadowed");` },
    { code: `function log(console: { error(m: string): void }) { console.error("param"); }` },
  ],
  invalid: [
    {
      code: `console.error("save failed", error);`,
      errors: [{ messageId: "console", data: { method: "error" } }],
    },
    {
      code: `"use server";\nconsole.warn("x");`,
      errors: [{ messageId: "console", data: { method: "warn" } }],
    },
    {
      code: `const f = () => { "use client"; console.log("not a module directive"); };`,
      errors: [{ messageId: "console", data: { method: "log" } }],
    },
    {
      code: `import x from "y";\n"use client";\nconsole.info(x);`,
      errors: [{ messageId: "console", data: { method: "info" } }],
    },
    {
      code: `onFallback(console.warn);`,
      errors: [{ messageId: "console", data: { method: "warn" } }],
    },
  ],
});
