/**
 * `xos canon validate --file rows.csv [--column COLUMN=resource ...]`
 *
 * Checks every canon code in a file against the live canon read endpoints. Columns are matched
 * by name to the canon resource whose identifier has that name (for example `dept_code` to
 * `canonDepartments`), derived from the operation table, so new canon endpoints are picked up
 * without a CLI change. Codes are compared exactly; canon values are never guessed.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { OperationSpec } from "@ghxstship/xos-sdk";
import { OPERATIONS } from "@ghxstship/xos-sdk";
import { parsePairs, toCamel } from "../args.ts";
import type { Context } from "../context.ts";
import { parseRows } from "../csv.ts";
import { UsageError } from "../io.ts";
import { render } from "../output.ts";

export interface CanonColumn {
  readonly column: string;
  readonly list: OperationSpec;
}

/** Canon resources keyed by the name of their identifier, from `canon*.get` operations. */
export function canonColumns(): Map<string, OperationSpec> {
  const out = new Map<string, OperationSpec>();
  for (const spec of Object.values(OPERATIONS as Readonly<Record<string, OperationSpec>>)) {
    if (!spec.resource.startsWith("canon") || spec.verb !== "get" || spec.pathParams.length !== 1)
      continue;
    const list = (OPERATIONS as Readonly<Record<string, OperationSpec>>)[`${spec.resource}.list`];
    const key = spec.pathParams[0] as string;
    if (list && key !== "code" && !out.has(key)) out.set(key, list);
  }
  return out;
}

export async function canonCommand(ctx: Context, argv: readonly string[]): Promise<number> {
  const [action, ...rest] = argv;
  if (action !== "validate") throw new UsageError("Use `xos canon validate --file rows.csv`.");
  const { values } = parseArgs({
    args: rest,
    options: { file: { type: "string" }, column: { type: "string", multiple: true } },
  });
  if (!values.file) throw new UsageError("`xos canon validate` needs --file.");
  const rows = parseRows(readFileSync(values.file, "utf8"), values.file);
  const known = canonColumns();
  for (const [column, resource] of Object.entries(parsePairs(values.column ?? [], "--column"))) {
    const list = (OPERATIONS as Readonly<Record<string, OperationSpec>>)[
      `${toCamel(resource)}.list`
    ];
    if (!list || !list.resource.startsWith("canon"))
      throw new UsageError(`"${resource}" is not a canon resource with a list operation.`);
    known.set(column, list);
  }
  const header = new Set(rows.flatMap((r) => Object.keys(r)));
  const columns: CanonColumn[] = [...header]
    .filter((c) => known.has(c))
    .map((c) => ({ column: c, list: known.get(c) as OperationSpec }));
  if (columns.length === 0) {
    throw new UsageError(
      `No canon code columns found. Known columns: ${[...known.keys()].sort().join(", ")}. Map others with --column name=canonResource.`,
    );
  }

  const client = ctx.client();
  const findings: { row: number; column: string; value: string; problem: string }[] = [];
  for (const { column, list } of columns) {
    const codes = new Set<string>();
    const keyField =
      (OPERATIONS as Readonly<Record<string, OperationSpec>>)[`${list.resource}.get`]
        ?.pathParams[0] ?? column;
    for await (const entry of client.paginate<Record<string, unknown>>(list, {
      query: { limit: 200 },
    })) {
      codes.add(String(entry[keyField]));
    }
    rows.forEach((row, i) => {
      const value = row[column];
      if (value === null || value === undefined || value === "") return;
      if (!codes.has(String(value))) {
        findings.push({
          row: i + 1,
          column,
          value: String(value),
          problem: `not in ${list.resource}`,
        });
      }
    });
  }
  render(ctx.io, ctx.format, findings, "row,column,value,problem");
  ctx.io.stderr(
    findings.length === 0
      ? `All canon codes in ${columns.map((c) => c.column).join(", ")} are valid across ${rows.length} row(s).\n`
      : `${findings.length} canon code(s) are not in canon. Correct them, or propose an extension with \`xos canon-intake create\`.\n`,
  );
  return findings.length === 0 ? 0 : 1;
}
