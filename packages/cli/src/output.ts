/** Renders results as JSON (for scripts) or a plain table (for people). */
import type { Io } from "./io.ts";
import { UsageError } from "./io.ts";

export type OutputFormat = "json" | "table";

export function outputFormat(flag: string | undefined, io: Io): OutputFormat {
  if (flag === undefined) return io.isTTY ? "table" : "json";
  if (flag === "json" || flag === "table") return flag;
  throw new UsageError(`--output takes json or table; got "${flag}".`);
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ((value as { masked?: unknown }).masked === true) return "(masked)";
    return JSON.stringify(value);
  }
  return String(value);
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** Columns for a list: the requested fields, else `id` and the first scalar members. */
export function columnsFor(rows: readonly Record<string, unknown>[], fields?: string): string[] {
  if (fields)
    return [...new Set(["id", ...fields.split(",")])].filter((c) => rows.some((r) => c in r));
  const first = rows[0] ?? {};
  const keys = Object.keys(first).filter(
    (k) => isScalar(first[k]) && !["org_id", "created_by", "updated_by"].includes(k),
  );
  const ordered = keys.includes("id") ? ["id", ...keys.filter((k) => k !== "id")] : keys;
  return ordered.slice(0, 6);
}

export function table(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
): string {
  const widths = columns.map((c) =>
    Math.min(48, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))),
  );
  const line = (values: readonly string[]) =>
    values
      .map((v, i) => {
        const w = widths[i] as number;
        return (v.length > w ? `${v.slice(0, w - 1)}…` : v).padEnd(w);
      })
      .join("  ")
      .trimEnd();
  return [
    line(columns),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map((r) => line(columns.map((c) => cell(r[c])))),
  ].join("\n");
}

export function render(io: Io, format: OutputFormat, value: unknown, fields?: string): void {
  if (format === "json") {
    io.stdout(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (Array.isArray(value)) {
    const rows = value as Record<string, unknown>[];
    io.stdout(
      rows.length === 0 ? "No rows match.\n" : `${table(rows, columnsFor(rows, fields))}\n`,
    );
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const width = Math.max(...entries.map(([k]) => k.length));
    io.stdout(`${entries.map(([k, v]) => `${k.padEnd(width)}  ${cell(v)}`).join("\n")}\n`);
    return;
  }
  if (value !== undefined) io.stdout(`${cell(value)}\n`);
}
