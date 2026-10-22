import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditForms } from "../src/form-audit-cli.ts";
import { findFormsThatLoseInput } from "../src/form-audit.ts";

describe("findFormsThatLoseInput", () => {
  it("reports a posting form with a typed field and no onSubmit", () => {
    const source = [
      `export function A() {`,
      `  return (`,
      `    <form`,
      `      action={formAction}`,
      `      className={x > 1 ? "a" : "b"}`,
      `    >`,
      `      <Input name="title" />`,
      `    </form>`,
      `  );`,
      `}`,
    ].join("\n");
    expect(findFormsThatLoseInput("a.tsx", source)).toEqual([
      {
        file: "a.tsx",
        line: 3,
        snippet: `<form action={formAction} className={x > 1 ? "a" : "b"} >`,
      },
    ]);
  });

  it("accepts forms that keep input, navigate with GET, or hold no typed field", () => {
    const keeps = `<form action={a} onSubmit={keepInputOnSubmit(a)}><Input name="t" /></form>`;
    const get = `<form method="get" action={path}><input name="q" /></form>`;
    const buttons = `<form action={a}><input type="hidden" name="id" value={id} /><Button type="submit" /></form>`;
    const spread = `<form action={a} {...keep}><Textarea name="t" /></form>`;
    const url = '<form method="post" action={`/share/${token}/file`}><input name="code" /></form>';
    const settled = `<form action={save} data-keep-input="not-refusable"><input type="checkbox" name="p" /></form>`;
    for (const source of [keeps, spread, get, buttons, url, settled])
      expect(findFormsThatLoseInput("b.tsx", source)).toEqual([]);
  });

  it("treats forms that render children as holding fields", () => {
    expect(findFormsThatLoseInput("c.tsx", `<form action={a}>{children}</form>`)).toHaveLength(1);
  });
});

describe("input kept after refusal", () => {
  it("every Atlas and Gateway form keeps typed input when a save is refused", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    expect(auditForms(root)).toEqual([]);
  });
});
