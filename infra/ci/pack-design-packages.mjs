#!/usr/bin/env node
/**
 * Packs the five design packages for npm: tokens, icons, i18n, schemas and ui.
 *
 * In the workspace they are `@xos/*`, private, at version 0.0.0, and consumed as TypeScript source. `@xos` on
 * npm belongs to someone else (ADR 0024, 2026-10-28 amendment), so each one publishes as `@ghxstship/xos-<name>`
 * at the release version. Nothing in the workspace is renamed: this script stages a copy of each package's
 * tracked files, writes a publish manifest beside them and packs that.
 *
 * A published package depends on its siblings through npm aliases (`"@xos/tokens": "npm:@ghxstship/xos-tokens@X.Y.Z"`),
 * so the source inside the archive keeps importing `@xos/*`, unchanged from the tag. A consumer
 * installs them the same way and transpiles them as the Atlas apps do (infra/ci/README.md, section 5).
 *
 * No published file may make a browser, a bundler or a runtime ask another host for anything: the self-check
 * fails on a remote `@import`, a remote `url()`, a remote module specifier and every other remote address that
 * TEXT_ONLY_REFERENCES does not list (issue 110).
 *
 * Usage: node infra/ci/pack-design-packages.mjs <version> <output directory>
 * Exits non-zero when an archive would not stand on its own.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCOPE = "@ghxstship";

/** Publish order: a package comes after the packages it depends on. */
export const PACKAGES = ["tokens", "icons", "i18n", "schemas", "ui"];

export const publishedName = (pkg) => `${SCOPE}/xos-${pkg}`;
/** npm names a scoped archive <scope>-<name>-<version>.tgz. */
export const archiveName = (pkg, version) => `ghxstship-xos-${pkg}-${version}.tgz`;

/** Tracked files that are tooling, tests or stories, never part of what a consumer imports. */
const EXCLUDED = [
  /^package\.json$/,
  /^(test|tests|stories|coverage|storybook-static|\.storybook)\//,
  /(^|\/)__snapshots__\//,
  /\.(test|spec|stories)\.[cm]?[jt]sx?$/,
  /^(eslint|stylelint|vitest|playwright)\.config\.[cm]?[jt]s$/,
  /^tsconfig(\..+)?\.json$/,
  /^turbo\.json$/,
];

/**
 * Maintainer files inside a package's source: generator command lines, the translation pipeline, the airports
 * download (it fetches the OurAirports file from its publisher) and the design export's stylesheet that the
 * components were ported from. No export reaches them, so they stay out of the archive.
 */
const TOOLING = {
  i18n: [/^src\/translation\//, /^scripts\//],
  schemas: [/(^|\/)generate-cli\.ts$/, /^src\/airports\/fetch(-cli)?\.ts$/],
  ui: [/^src\/styles\/reference\.css$/],
};

/** Packages whose stylesheets name the font families, so their README says which fonts a consumer serves. */
const FONT_PACKAGES = ["tokens", "ui"];

/** Build output a package exports but git does not track. The caller builds it before packing. */
const BUILT = { tokens: ["dist"] };

/** Manifest fields that describe the workspace, not the published package. */
const DROPPED_FIELDS = ["private", "scripts", "devDependencies", "files", "publishConfig"];

const SOURCE = /\.[cm]?[jt]sx?$/;

/** Stylesheets: CSS, and the PostCSS and preprocessor dialects a bundler compiles to it. */
const STYLESHEET = /\.(?:css|pcss|postcss|scss|sass|less|styl)$/;

/** Images, pages, data and single-file components: read as markup, where any remote address counts. */
const MARKUP = /\.(?:svg|html?|xhtml|xml|json|webmanifest|map|vue|svelte|astro)$/;

/**
 * Files the remote check does not read. Prose and tabular data (Markdown, text, YAML, CSV, license files) are
 * read by people and parsers that follow no address, and a raster image holds pixels.
 */
const NOT_READ =
  /(?:\.(?:md|txt|ya?ml|csv|png|jpe?g|gif|webp|avif|ico)|(?:^|\/)(?:LICENSE|THIRD_PARTY_NOTICES))$/;

/**
 * How the remote check reads a published file: `stylesheet`, `script` or `markup`, `skipped` for a type on the
 * not-read list, and `unknown` for every other type. An unknown type fails the pack, so a new kind of file is
 * read or skipped by a decision made here, never by default.
 */
export function scanKind(file) {
  if (STYLESHEET.test(file)) return "stylesheet";
  if (SOURCE.test(file)) return "script";
  if (MARKUP.test(file)) return "markup";
  if (NOT_READ.test(file)) return "skipped";
  return "unknown";
}

/**
 * Remote addresses a published file may hold because no browser, bundler or runtime loads them. Every other
 * remote address fails the pack, and an `@import`, a `url()` or a module specifier fails whatever this list
 * says. `files` is matched against `<package>/<path in the archive>`.
 */
export const TEXT_ONLY_REFERENCES = [
  {
    // An XML namespace name on an svg element. Parsers compare it as a string and never fetch it.
    url: /^http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink)$/,
    files: /^(?:icons|ui)\/.+\.(?:svg|mjs|tsx)$/,
  },
  {
    // The `$schema` keyword of a JSON Schema: the name of the dialect, which validators hold built in.
    url: /^https:\/\/json-schema\.org\/draft\/2020-12\/schema$/,
    files: /^schemas\/[^/]+\.schema\.json$/,
  },
  {
    // Example values in the API field descriptions, on the `.example` domain RFC 2606 reserves: no host answers.
    url: /^https:\/\/[a-z0-9-]+\.example\//,
    files: /^schemas\/src\/common\/fields\.ts$/,
  },
  {
    // Interface copy: the text a pasted Google Sheets link must start with, shown to the person as a sentence.
    url: /^https:\/\/docs\.google\.com\/spreadsheets\/d\/$/,
    files: /^i18n\/messages\/[^/]+\/platform\.json$/,
  },
  {
    // The citation beside the translation price the pipeline budgets with; the published package never reads it.
    url: /^https:\/\/cloud\.google\.com\/translate\/pricing$/,
    files: /^i18n\/translation\/config\.json$/,
  },
];
const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.d.ts",
];
const BUILTINS = new Set(builtinModules);

function fail(message) {
  throw new Error(message);
}

function trackedFiles(pkg) {
  const out = execFileSync("git", ["ls-files", "-z", "--", `packages/${pkg}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const prefix = `packages/${pkg}/`;
  return out
    .split("\0")
    .filter(Boolean)
    .map((path) => path.slice(prefix.length))
    .filter(
      (path) => ![...EXCLUDED, ...(TOOLING[pkg] ?? [])].some((pattern) => pattern.test(path)),
    );
}

function builtFiles(pkg) {
  return (BUILT[pkg] ?? []).flatMap((dir) => {
    const root = join(ROOT, "packages", pkg, dir);
    if (!existsSync(root))
      fail(`packages/${pkg}/${dir} is missing; run pnpm --filter @xos/${pkg} build first`);
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        posix.join(dir, relative(root, join(entry.parentPath, entry.name)).split(sep).join("/")),
      );
  });
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets);
  return [];
}

export function publishManifest(manifest, pkg, version) {
  const out = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (!DROPPED_FIELDS.includes(key)) out[key] = value;
  }
  out.name = publishedName(pkg);
  out.version = version;
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    if (!manifest[field]) continue;
    out[field] = Object.fromEntries(
      Object.entries(manifest[field]).map(([name, range]) => {
        if (!String(range).startsWith("workspace:")) return [name, range];
        const sibling = name.replace(/^@xos\//, "");
        if (!PACKAGES.includes(sibling))
          fail(`${manifest.name} depends on ${name}, which is not published`);
        return [name, `npm:${publishedName(sibling)}@${version}`];
      }),
    );
  }
  out.repository = {
    type: "git",
    url: "git+https://github.com/ghxstship/atlas.git",
    directory: `packages/${pkg}`,
  };
  // No provenance: npm signs it only for a public repository (infra/ci/README.md, section 5).
  out.publishConfig = { access: "public", provenance: false };
  return out;
}

/** The README section that says which fonts a consumer serves, from packages/tokens/fonts.json. */
export function fontsSection(fonts, pkg) {
  const row = (font) => {
    const names = [font.family, ...font.alsoNamed].map((name) => `\`${name}\``).join(", then ");
    const list = (files) => files.map((file) => `\`${file}\``).join(", ");
    const files =
      font.files.variable.length > 0
        ? `${list(font.files.variable)} for every weight, or ${list(font.files.static)}`
        : list(font.files.static);
    return `| ${font.family} | \`${font.token}\` | ${names} | ${font.weights.join(", ")} | ${font.style} | ${files} | ${font.license}, \`${font.licenseFile}\` |`;
  };
  return [
    "## Fonts",
    "",
    "No file in this package names another host to load from, and the package ships no font file.",
    `Its styles name ${fonts.families.length} font families through the tokens. Serve these files from the consuming site's own origin, with each release's license file beside them, and declare them with \`@font-face\` under the family names below:`,
    "",
    "| Family | Token | `font-family` names | Weights | Style | Files, as the upstream release names them | License, and its file in that release |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...fonts.families.map(row),
    "",
    "Without the files a browser uses a copy installed on the device, and otherwise the next family in the token's list.",
    pkg === "tokens"
      ? "`FONTS.md` in this package has the `@font-face` rules, and `fonts.json` holds this table as data."
      : `\`FONTS.md\` in \`${publishedName("tokens")}\` has the \`@font-face\` rules, and its \`fonts.json\` holds this table as data.`,
    "",
  ];
}

function readme(manifest, pkg, version, thirdParty, fonts) {
  const name = publishedName(pkg);
  const siblings = Object.keys(manifest.dependencies ?? {}).filter((dep) =>
    dep.startsWith("@xos/"),
  );
  const aliases = [manifest.name, ...siblings]
    .map((dep) => `    "${dep}": "npm:${publishedName(dep.replace(/^@xos\//, ""))}@${version}"`)
    .join(",\n");
  return [
    `# ${name}`,
    "",
    manifest.description ?? "",
    "",
    `This is \`${manifest.name}\` from the Atlas repository at release v${version}, published under the \`${SCOPE}\` scope.`,
    "The archive holds the package's TypeScript source as the release tag does.",
    "",
    "## Install",
    "",
    `The source imports its sibling packages as \`@xos/*\`, so install it under its workspace name with an npm alias, at an exact version:`,
    "",
    "```json",
    "{",
    '  "dependencies": {',
    aliases,
    "  }",
    "}",
    "```",
    "",
    "## Build",
    "",
    "The package ships TypeScript, so the consuming build transpiles it.",
    "",
    `- In Next.js, list both names of every installed package in \`transpilePackages\`, for example \`"${manifest.name}"\` and \`"${name}"\`. pnpm resolves an alias to the published name, so the alias alone is not enough.`,
    "- The source imports its own files with `.ts` and `.tsx` extensions, so the consumer's `tsconfig.json` sets `allowImportingTsExtensions` (with `noEmit` and bundler module resolution).",
    ...(manifest.peerDependencies
      ? [
          `- Peer dependencies are exact, as in Atlas at this release: ${Object.entries(
            manifest.peerDependencies,
          )
            .map(([dep, range]) => `\`${dep}\` ${range}`)
            .join(", ")}.`,
        ]
      : []),
    "",
    ...(FONT_PACKAGES.includes(pkg) ? fontsSection(fonts, pkg) : []),
    "## License",
    "",
    `${manifest.license}. See \`LICENSE\`${thirdParty ? " and `THIRD_PARTY_NOTICES`" : ""}.`,
    "",
  ].join("\n");
}

/** Every module specifier a source file imports, exports from or requires. */
function specifiers(source) {
  const found = new Set();
  const patterns = [
    /(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*["']([^"']+)["']/g,
    /(?:^|[\s;])import\s*["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

function resolvesRelative(staged, from, specifier) {
  const clean = specifier.replace(/[?#].*$/, "");
  const base = posix.normalize(posix.join(posix.dirname(from), clean));
  if (base.startsWith("..")) return false;
  const stems = [base];
  // TypeScript sources may name a sibling by its emitted extension.
  if (/\.[cm]?js$/.test(base))
    stems.push(base.replace(/\.([cm]?)js$/, ".$1ts"), base.replace(/\.js$/, ".tsx"));
  return stems.some((stem) => RESOLVE_SUFFIXES.some((suffix) => staged.has(stem + suffix)));
}

function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Every specifier a stylesheet loads: imports, and Tailwind's config, plugin, reference and source files. */
function cssSpecifiers(source) {
  const found = new Set();
  for (const match of source.matchAll(
    /@(?:import|config|plugin|reference)\s+(?:url\()?["']([^"']+)["']/g,
  ))
    found.add(match[1]);
  return [...found];
}

const withoutCssComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length));

/**
 * An http, https, ws, wss or ftp address, or a protocol-relative one (`//host/path`). A scheme with no host
 * after it (copy such as "starts with https://.") is no address. In a script `//` also starts a comment, so
 * the protocol-relative form counts there only inside a string or a template (insideString).
 */
const ABSOLUTE = String.raw`\b(?:https?|wss?|ftp):\/\/(?=[\w[$\{%@])[^\s"'\`()<>\\]+`;
const RELATIVE = String.raw`\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s"'\`()<>\\]*`;
const REMOTE = new RegExp(`${ABSOLUTE}|(?<![:\\w/\\\\])${RELATIVE}`, "gi");

const unescapedBackticks = (text) => (text.match(/(?<!\\)`/g) ?? []).length;

/**
 * True when the `//` at `index` of a script sits in a string or a template, where it is part of an address
 * such as `"url(//host/a.woff2)"` or `${protocol}//host/path`, and false when it starts a line comment.
 *
 * It reads the line up to `index`, opening and closing quotes as it goes; the line starts inside a template
 * when an odd number of backticks precede it in the file. No parser is used, so a quote inside a regular
 * expression can mislead it. For that case a `//` directly after a quote, `(`, `=` or `}` always counts: the
 * check then reports a comment it should have passed, never the reverse.
 */
function insideString(text, index) {
  if (/["'`(=}]/.test(text[index - 1] ?? "")) return true;
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  let quote = unescapedBackticks(text.slice(0, lineStart)) % 2 === 1 ? "`" : "";
  for (let at = lineStart; at < index; at += 1) {
    const char = text[at];
    if (quote) {
      if (char === "\\") at += 1;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "/" && text[at + 1] === "/") {
      return false;
    }
  }
  return quote !== "";
}

/** What makes the file load the address: `import` (a stylesheet or module import), `url` (a CSS url()) or nothing. */
function loadedThrough(kind, before) {
  if (kind === "stylesheet") {
    // Sass loads through @use and @forward as well, and Less puts options between @import and the address.
    if (/@(?:import|use|forward)\s+(?:\([^)]*\)\s*)?(?:url\(\s*)?["']?$/i.test(before))
      return "import";
    if (/@namespace\s[^;]*$/i.test(before)) return "text";
    if (/url\(\s*["']?$/i.test(before)) return "url";
    return "text";
  }
  if (kind === "script") {
    if (
      /(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\(|\bimportScripts\s*\()\s*["'`]$/.test(before)
    )
      return "import";
    // A url() in a style object or an injected stylesheet string loads as it does in a stylesheet.
    if (/url\(\s*(?:\\?["'])?$/i.test(before)) return "url";
  }
  return "text";
}

/**
 * Every remote address in a published file: `{ url, through }`, where `through` is `import`, `url` or `text`.
 * Block comments in a stylesheet are text nobody loads, so they are skipped. A script's comments are not:
 * telling a comment from a string needs a parser, and an address in one is listed in TEXT_ONLY_REFERENCES or
 * removed. The one exception is a protocol-relative address, which a script holds only in a string.
 */
export function remoteReferences(file, source) {
  const kind = scanKind(file);
  const text = kind === "stylesheet" ? withoutCssComments(source) : source;
  return [...text.matchAll(REMOTE)]
    .filter(
      (match) => kind !== "script" || !match[0].startsWith("//") || insideString(text, match.index),
    )
    .map((match) => ({
      // Punctuation that ends a sentence or a list is not part of the address.
      url: match[0].replace(/[.,;:!?]+$/, ""),
      through: loadedThrough(kind, text.slice(Math.max(0, match.index - 200), match.index)),
    }));
}

/** True when the address is on the text-only list for this file of this package. */
export function textOnly(pkg, file, url) {
  return TEXT_ONLY_REFERENCES.some(
    (entry) => entry.url.test(url) && entry.files.test(`${pkg}/${file}`),
  );
}

/** One problem for every remote address a published file loads or names without being listed as text only. */
export function remoteProblems(pkg, file, source) {
  return remoteReferences(file, source).flatMap(({ url, through }) => {
    if (through === "import") return [`${file} imports ${url} from another host`];
    if (through === "url") return [`${file} loads ${url} from another host through url()`];
    if (textOnly(pkg, file, url)) return [];
    return [
      `${file} names the remote address ${url}, which TEXT_ONLY_REFERENCES does not list for it`,
    ];
  });
}

/** Problems that would stop the staged package from standing on its own; empty when it does. */
export function problems(dir, files, manifest, workspaceName) {
  const staged = new Set(files);
  const found = [];
  for (const target of exportTargets(manifest.exports)) {
    const path = target.replace(/^\.\//, "");
    if (path.includes("*")) {
      const [head, tail] = path.split("*");
      if (!files.some((file) => file.startsWith(head) && file.endsWith(tail)))
        found.push(`exports target ${target} matches no file`);
    } else if (!staged.has(path)) {
      found.push(`exports target ${target} is not in the archive`);
    }
  }
  const declared = new Set([
    workspaceName,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  // Everything under src/ and every file an export names directly: a consumer can load any of them.
  const exported = new Set(
    exportTargets(manifest.exports).map((target) => target.replace(/^\.\//, "")),
  );
  for (const file of files) {
    const css = file.endsWith(".css");
    if (!css && !SOURCE.test(file)) continue;
    if (!file.startsWith("src/") && !exported.has(file)) continue;
    const text = readFileSync(join(dir, file), "utf8");
    for (const specifier of css ? cssSpecifiers(text) : specifiers(text)) {
      // A remote specifier is never skipped: remoteProblems reports it below, with every other remote address.
      if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(specifier)) continue;
      if (specifier.startsWith(".")) {
        if (!resolvesRelative(staged, file, specifier))
          found.push(`${file} imports ${specifier}, which is not in the archive`);
      } else if (
        !specifier.startsWith("node:") &&
        !BUILTINS.has(packageOf(specifier)) &&
        !declared.has(packageOf(specifier))
      ) {
        found.push(`${file} imports ${specifier}, which is not a declared dependency`);
      }
    }
  }
  // The manifest is written by this script; its only address is the repository field, which npm displays.
  const pkg = workspaceName.replace(/^@xos\//, "");
  for (const file of files) {
    if (file === "package.json") continue;
    const kind = scanKind(file);
    if (kind === "skipped") continue;
    if (kind === "unknown")
      found.push(
        `${file} is of a type the remote check neither reads nor skips; add its extension to a list beside scanKind`,
      );
    else found.push(...remoteProblems(pkg, file, readFileSync(join(dir, file), "utf8")));
  }
  if (JSON.stringify(manifest).includes("workspace:"))
    found.push("the manifest still holds a workspace: range");
  return found;
}

function pack(pkg, version, outDir, stageRoot) {
  const source = join(ROOT, "packages", pkg);
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (manifest.name !== `@xos/${pkg}`)
    fail(`packages/${pkg} is ${manifest.name}, expected @xos/${pkg}`);
  const dir = join(stageRoot, pkg);
  const files = [...trackedFiles(pkg), ...builtFiles(pkg)];
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(source, file), join(dir, file));
  }
  if (!files.includes("LICENSE")) fail(`packages/${pkg} has no LICENSE`);
  const published = publishManifest(manifest, pkg, version);
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
  if (!files.includes("README.md")) {
    const fonts = JSON.parse(readFileSync(join(ROOT, "packages/tokens/fonts.json"), "utf8"));
    writeFileSync(
      join(dir, "README.md"),
      readme(manifest, pkg, version, files.includes("THIRD_PARTY_NOTICES"), fonts),
    );
    files.push("README.md");
  }
  const found = problems(dir, files, published, manifest.name);
  if (found.length > 0) {
    for (const problem of found) console.error(`${published.name}: ${problem}`);
    return false;
  }
  execFileSync("npm", ["pack", "--silent", "--pack-destination", outDir], {
    cwd: dir,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const archive = join(outDir, archiveName(pkg, version));
  if (!existsSync(archive)) fail(`npm pack did not write ${archive}`);
  const listed = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const missing = files.filter((file) => !listed.includes(`package/${file}`));
  if (missing.length > 0) {
    console.error(
      `${published.name}: npm pack left out ${missing.length} files, first ${missing[0]}`,
    );
    return false;
  }
  console.log(`${published.name}@${version}: ${listed.length} files, ${archive}`);
  return true;
}

function main() {
  const [version, out] = process.argv.slice(2);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !out)
    fail("usage: pack-design-packages.mjs <version> <output directory>");
  const outDir = resolve(out);
  mkdirSync(outDir, { recursive: true });
  const stageRoot = mkdtempSync(join(tmpdir(), "xos-design-packages-"));
  try {
    const results = PACKAGES.map((pkg) => pack(pkg, version, outDir, stageRoot));
    if (results.includes(false)) process.exitCode = 1;
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`pack-design-packages: ${error.message}`);
    process.exitCode = 1;
  }
}
