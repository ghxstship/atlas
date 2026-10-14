/**
 * SDK generator entry point. Reads the committed OpenAPI document, emits the TypeScript and
 * Python SDK sources, and either writes them or, with `check`, reports every file that
 * differs from a fresh generation. CI runs the check so generated files are never hand-edited
 * (Section 19.4).
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import type { ApiIR, OpenApiDocument } from "./ir.ts";
import { buildIR } from "./ir.ts";
import { emitPython } from "./python-emitter.ts";
import type { EmittedFile } from "./ts-emitter.ts";
import { emitTypeScript } from "./ts-emitter.ts";

export { buildIR } from "./ir.ts";
export type { ApiIR, OperationIR, ResourceIR } from "./ir.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..", "..");
export const DOCUMENT_FILE = join(REPO_ROOT, "packages", "api", "openapi", "v1.json");

export type Target = "ts" | "python";

interface TargetConfig {
  /** Package root, relative to the repository root. */
  readonly root: string;
  /** Directories owned entirely by the generator; stale files in them are removed. */
  readonly ownedDirs: readonly string[];
  readonly emit: (ir: ApiIR) => EmittedFile[];
  readonly prettier: boolean;
}

export const TARGETS: Readonly<Record<Target, TargetConfig>> = {
  ts: {
    root: "packages/sdk-ts",
    ownedDirs: ["src/generated"],
    emit: emitTypeScript,
    prettier: true,
  },
  python: {
    root: "packages/sdk-python",
    ownedDirs: ["src/xos_sdk/_generated"],
    emit: emitPython,
    prettier: false,
  },
};

export function loadDocument(file: string = DOCUMENT_FILE): OpenApiDocument {
  return JSON.parse(readFileSync(file, "utf8")) as OpenApiDocument;
}

async function render(target: TargetConfig, ir: ApiIR): Promise<EmittedFile[]> {
  const files = target.emit(ir);
  if (!target.prettier) return files;
  const config = (await resolveConfig(join(REPO_ROOT, target.root, "package.json"))) ?? {};
  return Promise.all(
    files.map(async (f) => ({
      path: f.path,
      contents: await format(f.contents, { ...config, parser: "typescript" }),
    })),
  );
}

function listFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.map((e) => join(dir, e)).filter((p) => !p.includes("__pycache__"));
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export interface GenerateResult {
  readonly target: Target;
  readonly files: readonly string[];
  /** Files that differ from a fresh generation, are missing, or are stale extras. */
  readonly drift: readonly string[];
}

export async function generate(
  targets: readonly Target[],
  options: { readonly check: boolean; readonly document?: OpenApiDocument },
): Promise<GenerateResult[]> {
  const ir = buildIR(options.document ?? loadDocument());
  const results: GenerateResult[] = [];
  for (const target of targets) {
    const config = TARGETS[target];
    const root = join(REPO_ROOT, config.root);
    const files = await render(config, ir);
    const expected = new Map(files.map((f) => [join(root, f.path), f.contents]));
    const drift: string[] = [];
    for (const [file, contents] of expected) {
      if (readOrNull(file) !== contents) drift.push(relative(REPO_ROOT, file));
    }
    const existing = config.ownedDirs.flatMap((d) => listFiles(join(root, d)));
    const stale = existing.filter((f) => !expected.has(f) && /\.(ts|py)$/.test(f));
    drift.push(...stale.map((f) => relative(REPO_ROOT, f)));
    if (!options.check) {
      for (const f of stale) rmSync(f);
      for (const [file, contents] of expected) {
        mkdirSync(dirname(file), { recursive: true });
        if (readOrNull(file) !== contents) writeFileSync(file, contents);
      }
    }
    results.push({ target, files: [...expected.keys()].map((f) => relative(REPO_ROOT, f)), drift });
  }
  return results;
}
