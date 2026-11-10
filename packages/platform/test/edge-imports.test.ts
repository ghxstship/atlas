import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every value an Edge Function imports from a vendored bundle is one the bundle exports. A missing one is not a type
// error CI would see (the functions are Deno and CI has no Deno step): the module fails to link, so the function
// never boots. report-run shipped that way in 4.8, importing two names only its lazily loaded chunk had.

const functions = fileURLToPath(new URL("../../../supabase/functions/", import.meta.url));

/** The names a bundle exports: its `export { a, b as c }` lists (with or without `from`) and its declarations. */
function exportedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const [, list] of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const entry of (list ?? "").split(",")) {
      const name = entry
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  for (const [, name] of source.matchAll(
    /export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (name) names.add(name);
  }
  return names;
}

/** The value imports from vendored bundles in one source file, as [bundle file, name]. Type-only imports are erased. */
function vendorImports(source: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const [, typeOnly, list, bundle] of source.matchAll(
    /import\s+(type\s+)?\{([^}]*)\}\s*from\s*"\.\.\/_vendor\/([^"]+)"/g,
  )) {
    if (typeOnly || !list || !bundle) continue;
    for (const entry of list.split(",")) {
      const trimmed = entry.trim();
      if (trimmed === "" || trimmed.startsWith("type ")) continue;
      const [name = ""] = trimmed.split(/\s+as\s+/);
      found.push([bundle, name.trim()]);
    }
  }
  return found;
}

const sources = readdirSync(functions, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "_vendor")
  .flatMap((d) =>
    readdirSync(`${functions}${d.name}`)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => `${d.name}/${file}`),
  );

describe("Edge Function imports from the vendored bundles", () => {
  it("find sources to check", () => {
    expect(sources).toContain("report-run/index.ts");
  });

  it("name only what each bundle exports", () => {
    const exports = new Map<string, Set<string>>();
    const missing: string[] = [];
    for (const file of sources) {
      for (const [bundle, name] of vendorImports(readFileSync(`${functions}${file}`, "utf8"))) {
        let names = exports.get(bundle);
        if (!names) {
          names = exportedNames(readFileSync(`${functions}_vendor/${bundle}`, "utf8"));
          exports.set(bundle, names);
        }
        if (!names.has(name)) missing.push(`${file}: ${name} from _vendor/${bundle}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
