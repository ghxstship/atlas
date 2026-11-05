import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { copyLiterals, jsxNoLiterals } from "../eslint/copy-literals.mjs";

/**
 * The shared react/jsx-no-literals block (Section 15): JSX text must come from a catalog, props are
 * not copy, and the separators read the same in every locale. Tests are exempt.
 */
function linter(): ESLint {
  return new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.tsx"],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
      },
      ...copyLiterals,
    ],
  });
}

async function messages(code: string, filePath = "src/view.tsx"): Promise<string[]> {
  const [result] = await linter().lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? m.message);
}

describe("copy literals", () => {
  it("uses Atlas's options", () => {
    expect(jsxNoLiterals).toEqual([
      "error",
      { noStrings: true, ignoreProps: true, allowedStrings: ["·", "/", "…", ":", " "] },
    ]);
  });

  it("refuses JSX text and string expressions", async () => {
    expect(await messages(`const a = <p>Save</p>;`)).toEqual(["react/jsx-no-literals"]);
    expect(await messages("const a = <p>{`${n}%`}</p>;")).toEqual(["react/jsx-no-literals"]);
    expect(await messages(`const a = <p>{"Save"}</p>;`)).toEqual(["react/jsx-no-literals"]);
  });

  it("allows catalog calls, props and separators", async () => {
    expect(await messages(`const a = <p title="x" className="p-4">{t("save")}</p>;`)).toEqual([]);
    expect(await messages(`const a = <p>{a}{" · "}{b}{": "}{c}</p>;`)).toEqual([]);
  });

  it("leaves tests alone", async () => {
    expect(await messages(`const a = <p>Save</p>;`, "test/view.test.tsx")).toEqual([]);
  });
});
