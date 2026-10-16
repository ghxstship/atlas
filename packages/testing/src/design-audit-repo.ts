import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  checkInventory,
  definedProperties,
  exportedNames,
  findRawValues,
  findUnknownTokens,
  tokenUsage,
  type Finding,
  type InventoryResult,
} from "./design-audit.ts";
import { specComponents } from "./inventory.ts";

/** Source trees the audit reads, relative to the repository root. */
export const auditRoots = [
  "apps/atlas/app",
  "apps/atlas/components",
  "apps/atlas/lib",
  "apps/gateway/app",
  "apps/gateway/components",
  "apps/gateway/lib",
  "apps/docs/app",
  "apps/docs/components",
  "apps/compass/app",
  "apps/compass/src",
  "packages/ui/src",
  "packages/ui-native/src",
] as const;

/** Generated or verbatim reference files, which hold token values by design. */
const SKIP = [
  /\.generated\.ts$/,
  /src\/styles\/reference\.css$/,
  /\.test\.tsx?$/,
  /\.stories\.tsx?$/,
  /\/node_modules\//,
];
const SOURCE = /\.(tsx?|css)$/;

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (SOURCE.test(entry) && !SKIP.some((rule) => rule.test(path))) out.push(path);
  }
}

export interface DesignAuditReport {
  readonly files: number;
  readonly findings: readonly Finding[];
  readonly usage: ReadonlyMap<string, number>;
  readonly unusedTokens: readonly string[];
  readonly web: InventoryResult;
  readonly native: InventoryResult;
}

/** Runs every design QA check over the repository at `root`. */
export function runDesignAudit(root: string): DesignAuditReport {
  const files: string[] = [];
  for (const dir of auditRoots) walk(join(root, dir), files);
  const sources = new Map(files.map((file) => [relative(root, file), readFileSync(file, "utf8")]));

  const tokenDir = join(root, "packages/tokens/dist/css");
  const tokens = new Set<string>();
  for (const css of readdirSync(tokenDir)) {
    for (const name of definedProperties(readFileSync(join(tokenDir, css), "utf8")))
      tokens.add(name);
  }
  const defined = new Set(tokens);
  for (const source of sources.values())
    for (const name of definedProperties(source)) defined.add(name);

  const findings: Finding[] = [];
  for (const [file, source] of sources) {
    findings.push(...findRawValues(file, source), ...findUnknownTokens(file, source, defined));
  }
  const usage = tokenUsage(sources.values());
  const unusedTokens = [...tokens].filter((name) => !usage.has(name)).sort();

  const webExports = exportedNames(readFileSync(join(root, "packages/ui/src/index.ts"), "utf8"));
  const nativeExports = exportedNames(
    readFileSync(join(root, "packages/ui-native/src/index.ts"), "utf8"),
  );
  return {
    files: sources.size,
    findings,
    usage,
    unusedTokens,
    web: checkInventory(specComponents, webExports),
    native: checkInventory(specComponents, nativeExports),
  };
}
