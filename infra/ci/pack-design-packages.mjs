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
 * so the source inside the archive keeps importing `@xos/*` and is byte for byte what the tag holds. A consumer
 * installs them the same way and transpiles them as the Atlas apps do (infra/ci/README.md, section 5).
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
 * Maintainer tooling inside a package's source: generator command lines and the translation pipeline. No
 * export reaches them and they import development dependencies, so they stay out of the archive.
 */
const TOOLING = {
  i18n: [/^src\/translation\//, /^scripts\//],
  schemas: [/(^|\/)generate-cli\.ts$/],
};

/** Build output a package exports but git does not track. The caller builds it before packing. */
const BUILT = { tokens: ["dist"] };

/** Manifest fields that describe the workspace, not the published package. */
const DROPPED_FIELDS = ["private", "scripts", "devDependencies", "files", "publishConfig"];

const SOURCE = /\.[cm]?[jt]sx?$/;
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
  console.error(`pack-design-packages: ${message}`);
  process.exit(1);
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

function readme(manifest, pkg, version) {
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
    "The archive holds the package's TypeScript source exactly as the release tag does.",
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
    "The package ships TypeScript, so the consuming build transpiles it. In Next.js, list each alias in `transpilePackages`.",
    "",
    "## License",
    "",
    `${manifest.license}. See \`LICENSE\`.`,
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
  for (const file of files) {
    if (!SOURCE.test(file) || !file.startsWith("src/")) continue;
    for (const specifier of specifiers(readFileSync(join(dir, file), "utf8"))) {
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
    writeFileSync(join(dir, "README.md"), readme(manifest, pkg, version));
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
    if (results.includes(false)) process.exit(1);
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
