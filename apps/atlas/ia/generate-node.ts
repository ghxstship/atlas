import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSitemapFile } from "@xos/ia/node";
import { format, resolveConfig } from "prettier";
import {
  GENERATED_PREFIX,
  GENERATED_STAMP,
  generateFiles,
  parseAddons,
  parseLegalRegistry,
  parsePlanRegistry,
} from "./generate";

/** apps/atlas on disk. */
export const appRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** The generated files, formatted with the repository Prettier config, keyed by relative path. */
export async function renderGeneratedFiles(): Promise<Map<string, string>> {
  const sitemap = loadSitemapFile(join(appRoot, "ia/sitemap.yaml"));
  const legal = parseLegalRegistry(readFileSync(join(repoRoot, "legal/index.yaml"), "utf8"));
  const out = new Map<string, string>();
  const plansYaml = readFileSync(join(repoRoot, "packages/schemas/plans.yaml"), "utf8");
  const plans = parsePlanRegistry(plansYaml);
  for (const [path, source] of generateFiles(sitemap, legal, plans, parseAddons(plansYaml))) {
    const filepath = join(appRoot, path);
    const options = (await resolveConfig(filepath)) ?? {};
    out.set(path, await format(source, { ...options, filepath }));
  }
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/** Every file under app/ and lib/ and ia/ that carries the generated stamp, relative to apps/atlas. */
export function stampedFiles(): string[] {
  return ["app", "lib", "ia"]
    .flatMap((dir) => walk(join(appRoot, dir)))
    .filter(
      (path) => /\.tsx?$/.test(path) && readFileSync(path, "utf8").startsWith(GENERATED_PREFIX),
    )
    .map((path) => relative(appRoot, path))
    .sort();
}

/** Every page and route handler file under app/, relative to apps/atlas. */
export function routeFiles(): string[] {
  return walk(join(appRoot, "app"))
    .filter((path) => /\/(page|route)\.tsx?$/.test(path))
    .map((path) => relative(appRoot, path))
    .sort();
}

export { GENERATED_STAMP };
