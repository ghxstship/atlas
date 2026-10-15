import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The API handler generator imports this package under Node's TypeScript stripping, which resolves
// only explicit extensions, so every relative import here names its .ts file.
const root = fileURLToPath(new URL("../", import.meta.url));
const RELATIVE = /from\s+"(\.{1,2}\/[^"]+)"/g;

describe("relative imports", () => {
  it.each(["src", "test"])("%s names an explicit extension on every relative import", (dir) => {
    const missing = readdirSync(`${root}${dir}`)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) =>
        [...readFileSync(`${root}${dir}/${f}`, "utf8").matchAll(RELATIVE)]
          .map((m) => m[1] ?? "")
          .filter((spec) => !/\.(ts|json)$/.test(spec))
          .map((spec) => `${dir}/${f}: ${spec}`),
      );
    expect(missing).toEqual([]);
  });
});
