import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RepoPaths {
  readonly root: string;
  readonly canonSource: string;
  readonly canonMap: string;
  readonly canonReports: string;
  readonly migrations: string;
  readonly tests: string;
}

export function repoPaths(root: string): RepoPaths {
  const abs = resolve(root);
  return {
    root: abs,
    canonSource: join(abs, "canon", "source"),
    canonMap: join(abs, "canon", "map"),
    canonReports: join(abs, "canon", "reports"),
    migrations: join(abs, "supabase", "migrations"),
    tests: join(abs, "supabase", "tests"),
  };
}

/** The monorepo root, three levels above this file (canon/import/src). */
export function defaultRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
