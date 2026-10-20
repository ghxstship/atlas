/**
 * Reading and writing the translated surfaces. A catalog surface is a directory of namespace files
 * (messages/<locale>/<namespace>.json) and its units are the dotted keys; a markdown or text surface is
 * a directory of files and each file is one unit, identified as <surface id>/<file name>.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SurfaceConfig } from "./config.ts";

export type Format = "icu" | "markdown" | "text";

export interface UnitRecord {
  readonly id: string;
  readonly surface: SurfaceConfig;
  readonly format: Format;
  readonly source: string;
  readonly target: string | undefined;
  /** Catalog units: namespace file and path inside it. Markdown and text units: the file name. */
  readonly file: string;
  readonly path: readonly string[];
}

type Tree = { [key: string]: string | Tree };

export function surfaceDir(root: string, surface: SurfaceConfig, locale: string): string {
  return join(root, surface.path.replace("{locale}", locale));
}

function flatten(
  tree: Tree,
  prefix: string[],
  out: Array<{ path: string[]; value: string }>,
): void {
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === "string") out.push({ path: [...prefix, key], value });
    else flatten(value, [...prefix, key], out);
  }
}

function readJson(file: string): Tree {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Tree) : {};
}

function listFiles(dir: string, extension: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(extension))
        .sort()
    : [];
}

/** Every unit of a surface, with its en-US source and its current target (undefined when missing). */
export function readUnits(
  root: string,
  surface: SurfaceConfig,
  sourceLocale: string,
  targetLocale: string,
): UnitRecord[] {
  const sourceDir = surfaceDir(root, surface, sourceLocale);
  const targetDir = surfaceDir(root, surface, targetLocale);
  if (surface.kind === "catalog") {
    return listFiles(sourceDir, ".json").flatMap((file) => {
      const ns = file.slice(0, -".json".length);
      const source: Array<{ path: string[]; value: string }> = [];
      const target: Array<{ path: string[]; value: string }> = [];
      flatten(readJson(join(sourceDir, file)), [], source);
      flatten(readJson(join(targetDir, file)), [], target);
      const targets = new Map(target.map((t) => [t.path.join("."), t.value]));
      return source.map((s) => ({
        id: `${ns}.${s.path.join(".")}`,
        surface,
        format: "icu" as const,
        source: s.value,
        target: targets.get(s.path.join(".")),
        file,
        path: s.path,
      }));
    });
  }
  const extension = surface.extension ?? (surface.kind === "markdown" ? ".md" : ".txt");
  return listFiles(sourceDir, extension).map((file) => {
    const targetFile = join(targetDir, file);
    return {
      id: `${surface.id}/${file}`,
      surface,
      format: surface.kind === "markdown" ? ("markdown" as const) : ("text" as const),
      source: readFileSync(join(sourceDir, file), "utf8"),
      target: existsSync(targetFile) ? readFileSync(targetFile, "utf8") : undefined,
      file,
      path: [],
    };
  });
}

/** Keys of a target catalog that the source does not have, by unit id. */
export function extraCatalogKeys(
  root: string,
  surface: SurfaceConfig,
  sourceLocale: string,
  targetLocale: string,
): string[] {
  const sourceDir = surfaceDir(root, surface, sourceLocale);
  const targetDir = surfaceDir(root, surface, targetLocale);
  const sourceFiles = new Set(listFiles(sourceDir, ".json"));
  const out: string[] = [];
  for (const file of listFiles(targetDir, ".json")) {
    const ns = file.slice(0, -".json".length);
    const source: Array<{ path: string[]; value: string }> = [];
    const target: Array<{ path: string[]; value: string }> = [];
    if (sourceFiles.has(file)) flatten(readJson(join(sourceDir, file)), [], source);
    flatten(readJson(join(targetDir, file)), [], target);
    const keys = new Set(source.map((s) => s.path.join(".")));
    for (const t of target) if (!keys.has(t.path.join("."))) out.push(`${ns}.${t.path.join(".")}`);
  }
  return out;
}

export type Formatter = (text: string, file: string) => Promise<string>;

/**
 * Writes new target values. A catalog file is rebuilt in the source's key order with every value
 * (new or kept), so keys the source dropped disappear; a markdown or text file is replaced.
 * Returns the files written, relative to the root.
 */
export async function writeUnits(
  root: string,
  surface: SurfaceConfig,
  targetLocale: string,
  units: readonly UnitRecord[],
  values: ReadonlyMap<string, string>,
  format: Formatter,
): Promise<string[]> {
  const targetDir = surfaceDir(root, surface, targetLocale);
  const relative = (file: string) => join(surface.path.replace("{locale}", targetLocale), file);
  const written: string[] = [];
  const mine = units.filter((u) => u.surface.id === surface.id);
  if (surface.kind === "catalog") {
    const files = new Set(mine.filter((u) => values.has(u.id)).map((u) => u.file));
    for (const file of [...files].sort()) {
      const tree: Tree = {};
      for (const u of mine.filter((x) => x.file === file)) {
        const value = values.get(u.id) ?? u.target;
        if (value === undefined) continue;
        let node = tree;
        u.path.slice(0, -1).forEach((part) => {
          const next = node[part];
          if (typeof next === "object") node = next;
          else {
            const created: Tree = {};
            node[part] = created;
            node = created;
          }
        });
        node[u.path[u.path.length - 1] ?? ""] = value;
      }
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, file), `${JSON.stringify(tree, null, 2)}\n`);
      written.push(relative(file));
    }
    return written;
  }
  for (const u of mine) {
    const value = values.get(u.id);
    if (value === undefined) continue;
    const file = join(targetDir, u.file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, await format(value, file));
    written.push(relative(u.file));
  }
  return written;
}
