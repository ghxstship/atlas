import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findFormsThatLoseInput, type FormFinding } from "./form-audit.ts";

/** Roots holding the web apps' forms. */
export const formRoots = [
  "apps/atlas/app",
  "apps/atlas/components",
  "apps/gateway/app",
  "apps/gateway/components",
] as const;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) out.push(path);
  }
}

/** Every form in the web apps that would lose typed input after a refusal. */
export function auditForms(root: string): FormFinding[] {
  const files: string[] = [];
  for (const dir of formRoots) walk(join(root, dir), files);
  return files.flatMap((file) =>
    findFormsThatLoseInput(relative(root, file), readFileSync(file, "utf8")),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const findings = auditForms(root);
  for (const f of findings) process.stdout.write(`${f.file}:${f.line} ${f.snippet}\n`);
  process.stdout.write(`${findings.length} forms lose input after a refusal\n`);
  process.exitCode = findings.length > 0 ? 1 : 0;
}
