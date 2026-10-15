/**
 * Operation coverage (Section 18, gate 5): which documented operations have a handler, by module.
 * `pnpm --filter @xos/api coverage:operations` prints it; the operation coverage test also fails
 * when a handled operation is never exercised by an `expectContract` call.
 */
import { catalog, catalogOperationIds, handledOperations } from "./app.ts";
import { MODULES } from "./catalog/types.ts";
import type { Module } from "./catalog/types.ts";
import { MODULE_HANDLERS } from "./handlers/index.generated.ts";
import type { AnyModuleHandlers } from "./runtime/handler.ts";

export interface ModuleCoverage {
  readonly module: Module;
  readonly documented: number;
  readonly handled: readonly string[];
  readonly missing: readonly string[];
}

/** operationId to module, in document order. */
export function operationModules(): Map<string, Module> {
  const byOp = new Map(catalog.map((spec) => [spec.op, spec.module]));
  return new Map(
    catalogOperationIds().map((id) => [id, byOp.get(id.split(".")[0] as string) as Module]),
  );
}

export function operationCoverage(
  modules: readonly AnyModuleHandlers[] = MODULE_HANDLERS,
): ModuleCoverage[] {
  const handled = new Set(handledOperations(modules));
  const owners = operationModules();
  return MODULES.map((module) => {
    const ids = [...owners].filter(([, m]) => m === module).map(([id]) => id);
    return {
      module,
      documented: ids.length,
      handled: ids.filter((id) => handled.has(id)),
      missing: ids.filter((id) => !handled.has(id)),
    };
  });
}

/** A plain-text table: module, handled of documented, percentage. */
export function formatCoverage(rows: readonly ModuleCoverage[]): string {
  const total = rows.reduce((n, r) => n + r.documented, 0);
  const done = rows.reduce((n, r) => n + r.handled.length, 0);
  const pct = (a: number, b: number) => (b === 0 ? "0.0" : ((a / b) * 100).toFixed(1));
  const lines = rows.map(
    (r) =>
      `${r.module.padEnd(14)} ${String(r.handled.length).padStart(4)} / ${String(r.documented).padEnd(4)} ${pct(r.handled.length, r.documented).padStart(5)}%`,
  );
  return [
    "Module          Handled / Documented",
    ...lines,
    `${"Total".padEnd(14)} ${String(done).padStart(4)} / ${String(total).padEnd(4)} ${pct(done, total).padStart(5)}%`,
  ].join("\n");
}
