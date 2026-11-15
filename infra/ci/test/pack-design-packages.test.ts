import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PACKAGES,
  TEXT_ONLY_REFERENCES,
  archiveName,
  fontsSection,
  problems,
  publishManifest,
  publishedName,
  remoteProblems,
  remoteReferences,
  scanKind,
  textOnly,
  type FontFamily,
} from "../pack-design-packages.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const FONTS_HOST = "https://fonts.googleapis.com/css2?family=Inter";

const staged: string[] = [];
afterEach(() => {
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes the files into a temporary directory, as the script stages a package, and returns it. */
function stage(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-design-test-"));
  staged.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function check(files: Record<string, string>, manifest: Record<string, unknown> = {}): string[] {
  return problems(stage(files), Object.keys(files), manifest, "@xos/ui");
}

describe("published names", () => {
  it("publishes the five design packages under the owner's scope", () => {
    expect(PACKAGES).toEqual(["tokens", "icons", "i18n", "schemas", "ui"]);
    expect(publishedName("ui")).toBe("@ghxstship/xos-ui");
    expect(archiveName("ui", "4.17.0")).toBe("ghxstship-xos-ui-4.17.0.tgz");
  });

  it("writes a manifest with the release version and npm aliases for its siblings", () => {
    const manifest = publishManifest(
      {
        name: "@xos/ui",
        version: "0.0.0",
        private: true,
        scripts: { test: "vitest run" },
        devDependencies: { vitest: "5.0.3" },
        dependencies: { "@xos/tokens": "workspace:*", cmdk: "1.1.1" },
        peerDependencies: { react: "19.3.0" },
      },
      "ui",
      "4.17.0",
    );
    expect(manifest).toMatchObject({
      name: "@ghxstship/xos-ui",
      version: "4.17.0",
      dependencies: { "@xos/tokens": "npm:@ghxstship/xos-tokens@4.17.0", cmdk: "1.1.1" },
      peerDependencies: { react: "19.3.0" },
      publishConfig: { access: "public", provenance: false },
    });
    expect(manifest).not.toHaveProperty("private");
    expect(manifest).not.toHaveProperty("scripts");
    expect(manifest).not.toHaveProperty("devDependencies");
  });

  it("refuses a dependency on a workspace package that is not published", () => {
    expect(() =>
      publishManifest(
        { name: "@xos/ui", dependencies: { "@xos/data": "workspace:*" } },
        "ui",
        "4.17.0",
      ),
    ).toThrow("@xos/data, which is not published");
  });
});

describe("remote references in a stylesheet", () => {
  it("finds a remote import, with url() and without", () => {
    expect(remoteReferences("a.css", `@import url("${FONTS_HOST}");`)).toEqual([
      { url: FONTS_HOST, through: "import" },
    ]);
    expect(remoteReferences("a.css", `@import "https://cdn.test/a.css";`)).toEqual([
      { url: "https://cdn.test/a.css", through: "import" },
    ]);
    expect(remoteReferences("a.css", `@import url(//cdn.test/a.css) screen;`)).toEqual([
      { url: "//cdn.test/a.css", through: "import" },
    ]);
  });

  it("finds a remote url(), quoted, bare and protocol-relative", () => {
    const sheet = [
      `@font-face { font-family: Inter; src: url("https://fonts.gstatic.com/s/inter/v1/a.woff2") format("woff2"); }`,
      `.a { background: url(http://img.test/a.png); }`,
      `.b { background: url('//img.test/b.png'); }`,
    ].join("\n");
    expect(remoteReferences("a.css", sheet)).toEqual([
      { url: "https://fonts.gstatic.com/s/inter/v1/a.woff2", through: "url" },
      { url: "http://img.test/a.png", through: "url" },
      { url: "//img.test/b.png", through: "url" },
    ]);
  });

  it("finds a remote address outside import and url(), such as an image-set string", () => {
    expect(
      remoteReferences("a.css", `.a { background: image-set("https://img.test/a.png" 1x); }`),
    ).toEqual([{ url: "https://img.test/a.png", through: "text" }]);
  });

  it("passes local imports, local and data url() values and comments", () => {
    const sheet = [
      `/* The export imports ${FONTS_HOST}; this file does not. */`,
      `@import "tailwindcss";`,
      `@import "./base.css";`,
      `@import "@xos/tokens/css/base.css";`,
      `@font-face { font-family: Inter; src: url("/fonts/InterVariable.woff2") format("woff2"); }`,
      `.a { background: url(../img/a.png), url("data:image/png;base64,AAAA//8="); }`,
    ].join("\n");
    expect(remoteReferences("a.css", sheet)).toEqual([]);
  });

  it("fails an import and a url() whatever the text-only list says", () => {
    const svg = "http://www.w3.org/2000/svg";
    expect(textOnly("ui", "src/a.svg", svg)).toBe(true);
    expect(remoteProblems("ui", "src/a.css", `@import url("${svg}");`)).toEqual([
      `src/a.css imports ${svg} from another host`,
    ]);
    expect(remoteProblems("ui", "src/a.css", `.a { mask: url(${svg}); }`)).toEqual([
      `src/a.css loads ${svg} from another host through url()`,
    ]);
  });
});

describe("remote references in scripts, images and data", () => {
  it("finds a remote module specifier", () => {
    expect(remoteReferences("a.ts", `import x from "https://esm.test/x.js";`)).toEqual([
      { url: "https://esm.test/x.js", through: "import" },
    ]);
    expect(remoteReferences("a.js", `const x = await import("https://esm.test/x.js");`)).toEqual([
      { url: "https://esm.test/x.js", through: "import" },
    ]);
    expect(remoteReferences("sw.js", `importScripts("//cdn.test/sw.js");`)).toEqual([
      { url: "//cdn.test/sw.js", through: "import" },
    ]);
  });

  it("finds a remote address in a string, a template and a comment", () => {
    const source = [
      `// Downloaded from https://data.test/airports.csv.`,
      `const response = await fetch("https://api.test/v1");`,
      "const socket = new WebSocket(`wss://${host}/live`);",
      `const script = "//cdn.test/a.js";`,
    ].join("\n");
    expect(remoteReferences("a.ts", source).map((found) => found.url)).toEqual([
      "https://data.test/airports.csv",
      "https://api.test/v1",
      "wss://${host}/live",
      "//cdn.test/a.js",
    ]);
  });

  it("finds a protocol-relative address anywhere in a string or a template", () => {
    const font = "//fonts.gstatic.com/s/inter/v1/a.woff2";
    const sheet = "//fonts.googleapis.com/css2?family=Inter";
    expect(
      remoteProblems(
        "ui",
        "src/Icon/Icon.tsx",
        `export const bg = { backgroundImage: "url(${font})" };`,
      ),
    ).toEqual([`src/Icon/Icon.tsx loads ${font} from another host through url()`]);
    expect(
      remoteReferences(
        "a.ts",
        "export const load = () => fetch(`${location.protocol}" + sheet + "`);",
      ),
    ).toEqual([{ url: sheet, through: "text" }]);
    const source = [
      `const style = "@font-face { src: url('${font}') }";`,
      `const tag = '<script src=//cdn.test/a.js></script>';`,
      `const note = "it's loaded from //cdn.test/b.js";`,
      "const page = `",
      "  <link rel=stylesheet href= //cdn.test/c.css>",
      "`;",
    ].join("\n");
    expect(remoteReferences("a.ts", source)).toEqual([
      { url: font, through: "url" },
      { url: "//cdn.test/a.js", through: "text" },
      { url: "//cdn.test/b.js", through: "text" },
      { url: "//cdn.test/c.css", through: "text" },
    ]);
  });

  it("fails a url() in a script whatever the text-only list says", () => {
    const svg = "http://www.w3.org/2000/svg";
    expect(textOnly("ui", "src/a.tsx", svg)).toBe(true);
    expect(remoteProblems("ui", "src/a.tsx", `const mask = "url(${svg})";`)).toEqual([
      `src/a.tsx loads ${svg} from another host through url()`,
    ]);
  });

  it("passes a line comment that looks like a host, after code and after a closed string", () => {
    const source = [
      `//console.log(value);`,
      `const a = 1; //todo.md has the rest`,
      `const b = "it's"; //cdn.test/a.js is not loaded here`,
      `const c = 'x'; // see //cdn.test/b.js`,
    ].join("\n");
    expect(remoteReferences("a.ts", source)).toEqual([]);
  });

  it("passes line comments, paths, regular expressions and a scheme with no host", () => {
    const source = [
      `// see packages/ui/src/index.ts`,
      `//eslint-disable-next-line no-console`,
      `const path = "/fonts/Inter.woff2";`,
      `const comment = /\\/\\/.*$/;`,
      `const hint = "Enter a web address that starts with https://.";`,
    ].join("\n");
    expect(remoteReferences("a.ts", source)).toEqual([]);
  });

  it("finds a remote href in an svg and passes its namespace", () => {
    const image = `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://img.test/a.png"/></svg>`;
    expect(remoteProblems("ui", "src/brand/defaults/logo.svg", image)).toEqual([
      "src/brand/defaults/logo.svg names the remote address https://img.test/a.png, which TEXT_ONLY_REFERENCES does not list for it",
    ]);
  });

  it("drops the punctuation that ends a sentence", () => {
    const copy = `{ "hint": "Paste a link that starts with https://docs.google.com/spreadsheets/d/." }`;
    expect(remoteReferences("messages/en-US/platform.json", copy)).toEqual([
      { url: "https://docs.google.com/spreadsheets/d/", through: "text" },
    ]);
    expect(remoteProblems("i18n", "messages/en-US/platform.json", copy)).toEqual([]);
  });
});

describe("the types of file the remote check reads", () => {
  it("reads stylesheets of every dialect, scripts, images, pages and data", () => {
    for (const file of ["a.css", "a.scss", "a.sass", "a.less", "a.pcss", "a.styl"])
      expect(scanKind(file)).toBe("stylesheet");
    for (const file of ["a.ts", "a.tsx", "a.js", "a.mjs", "a.cjs", "a.jsx", "a.d.mts"])
      expect(scanKind(file)).toBe("script");
    for (const file of ["a.svg", "a.html", "a.json", "a.xml", "a.webmanifest", "a.vue", "a.js.map"])
      expect(scanKind(file)).toBe("markup");
  });

  it("skips prose, tabular data, license files and raster images, and nothing else", () => {
    for (const file of ["README.md", "a.txt", "a.yaml", "a.csv", "LICENSE", "a/b.png"])
      expect(scanKind(file)).toBe("skipped");
    for (const file of ["a.woff2", "a.wasm", "a.pdf", "Makefile", "a.css.bak"])
      expect(scanKind(file)).toBe("unknown");
  });

  it("finds a remote import in a Sass, Less and PostCSS stylesheet", () => {
    expect(remoteProblems("ui", "src/styles/extra.scss", `@import url("${FONTS_HOST}");`)).toEqual([
      `src/styles/extra.scss imports ${FONTS_HOST} from another host`,
    ]);
    expect(remoteReferences("a.scss", `@use "https://cdn.test/a";`)).toEqual([
      { url: "https://cdn.test/a", through: "import" },
    ]);
    expect(remoteReferences("a.less", `@import (css) url("//cdn.test/a.css");`)).toEqual([
      { url: "//cdn.test/a.css", through: "import" },
    ]);
    expect(remoteReferences("a.pcss", `.a { background: url(https://img.test/a.png); }`)).toEqual([
      { url: "https://img.test/a.png", through: "url" },
    ]);
  });
});

describe("the text-only list", () => {
  it("holds an address and the files it may appear in, for every entry", () => {
    for (const entry of TEXT_ONLY_REFERENCES) {
      expect(entry.url).toBeInstanceOf(RegExp);
      expect(entry.files).toBeInstanceOf(RegExp);
      // An entry that matched every address, or every file, would switch the check off.
      expect(entry.url.test(FONTS_HOST)).toBe(false);
      expect(entry.files.test("ui/src/styles/index.css")).toBe(false);
    }
  });

  it("excuses an address only in the files its entry names", () => {
    const sheets = "https://docs.google.com/spreadsheets/d/";
    expect(textOnly("i18n", "messages/es-US/platform.json", sheets)).toBe(true);
    expect(textOnly("i18n", "messages/es-US/gateway.json", sheets)).toBe(false);
    expect(textOnly("ui", "messages/es-US/platform.json", sheets)).toBe(false);
    expect(
      textOnly("schemas", "automation.schema.json", "https://json-schema.org/draft/2020-12/schema"),
    ).toBe(true);
    expect(
      textOnly(
        "schemas",
        "src/common/fields.ts",
        "https://northwindlive.example/files/site-plan.pdf",
      ),
    ).toBe(true);
    expect(
      textOnly("schemas", "src/common/fields.ts", "https://example.com/files/site-plan.pdf"),
    ).toBe(false);
  });
});

describe("the self-check of a staged package", () => {
  const manifest = {
    exports: { "./styles.css": "./src/styles/index.css", ".": "./src/index.ts" },
    dependencies: { "@xos/tokens": "npm:@ghxstship/xos-tokens@4.17.0" },
    peerDependencies: { tailwindcss: "4.3.3" },
  };
  const clean = {
    "src/index.ts": `export { cx } from "./lib/cx.ts";\n`,
    "src/lib/cx.ts": `export const cx = (...names: string[]) => names.join(" ");\n`,
    "src/styles/index.css": `@import "tailwindcss";\n@import "@xos/tokens/css/base.css";\n@import "./base.css";\n`,
    "src/styles/base.css": `body { font-family: var(--font-family-sans); }\n`,
    "README.md": `Source: https://github.com/ghxstship/atlas\n`,
  };

  it("passes a package that loads only its own files and declared packages", () => {
    expect(check(clean, manifest)).toEqual([]);
  });

  it("fails the first line of the design export's stylesheet (issue 110)", () => {
    const exported = readFileSync(
      join(repo, "design/xos-design-system/components/bundle.css"),
      "utf8",
    );
    const [first = ""] = exported.split("\n");
    const found = check({ ...clean, "src/styles/reference.css": exported }, manifest);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /^src\/styles\/reference\.css imports https:\/\/fonts\.googleapis\.com\/css2\?\S+ from another host$/,
    );
    expect(first).toContain(found[0]?.split(" ")[2]);
  });

  it("fails a remote import in a stylesheet no export names", () => {
    const found = check(
      { ...clean, "extra/print.css": `@import url("${FONTS_HOST}");\n` },
      manifest,
    );
    expect(found).toEqual([`extra/print.css imports ${FONTS_HOST} from another host`]);
  });

  it("fails a remote font file, a remote script address and a remote image", () => {
    const found = check(
      {
        ...clean,
        "src/styles/base.css": `@font-face { font-family: Inter; src: url(https://fonts.gstatic.com/a.woff2); }\n`,
        "src/lib/cx.ts": `export const cx = () => fetch("https://api.test/classes");\n`,
        "src/brand/defaults/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg"><use href="//img.test/a.svg#a"/></svg>`,
      },
      manifest,
    );
    expect(found).toEqual([
      "src/lib/cx.ts names the remote address https://api.test/classes, which TEXT_ONLY_REFERENCES does not list for it",
      "src/styles/base.css loads https://fonts.gstatic.com/a.woff2 from another host through url()",
      "src/brand/defaults/logo.svg names the remote address //img.test/a.svg#a, which TEXT_ONLY_REFERENCES does not list for it",
    ]);
  });

  it("fails a remote import in a stylesheet dialect, and a file of a type it does not know", () => {
    const found = check(
      {
        ...clean,
        "src/styles/extra.scss": `@import url("${FONTS_HOST}");\n`,
        "src/fonts/Inter.woff2": "wOF2",
        "src/brand/defaults/mark.png": "PNG https://img.test/pixels",
      },
      manifest,
    );
    expect(found).toEqual([
      `src/styles/extra.scss imports ${FONTS_HOST} from another host`,
      "src/fonts/Inter.woff2 is of a type the remote check neither reads nor skips; add its extension to a list beside scanKind",
    ]);
  });

  it("still fails a missing export target, a missing file, an undeclared package and a workspace range", () => {
    const found = check(
      {
        "src/index.ts": `import "./missing.ts";\nimport "left-pad";\n`,
        "src/styles/index.css": `@import "./missing.css";\n`,
      },
      {
        ...manifest,
        exports: { ...manifest.exports, "./gone": "./src/gone.ts" },
        optionalDependencies: { a: "workspace:*" },
      },
    );
    expect(found).toEqual([
      "exports target ./src/gone.ts is not in the archive",
      "src/index.ts imports ./missing.ts, which is not in the archive",
      "src/index.ts imports left-pad, which is not a declared dependency",
      "src/styles/index.css imports ./missing.css, which is not in the archive",
      "the manifest still holds a workspace: range",
    ]);
  });
});

describe("the fonts section of a generated README", () => {
  const fonts = JSON.parse(readFileSync(join(repo, "packages/tokens/fonts.json"), "utf8")) as {
    families: FontFamily[];
  };

  it.each(["tokens", "ui"])(
    "names every family, weight and file for %s, and no remote address",
    (pkg) => {
      const section = fontsSection(fonts, pkg).join("\n");
      expect(section).toContain("## Fonts");
      expect(section).toContain("No file in this package names another host to load from");
      for (const font of fonts.families) {
        expect(section).toContain(`| ${font.family} |`);
        expect(section).toContain(font.weights.join(", "));
        expect(section).toContain(`${font.license}, \`${font.licenseFile}\` |`);
        for (const file of [...font.files.variable, ...font.files.static])
          expect(section).toContain(file);
      }
      expect(remoteReferences("README.html", section)).toEqual([]);
    },
  );

  it("points the ui package at the tokens package for the @font-face rules", () => {
    expect(fontsSection(fonts, "ui").join("\n")).toContain("`FONTS.md` in `@ghxstship/xos-tokens`");
    expect(fontsSection(fonts, "tokens").join("\n")).toContain("`FONTS.md` in this package");
  });
});
