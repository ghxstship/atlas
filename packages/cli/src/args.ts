/** Flag grammar shared by the resource commands. */
import { readFileSync } from "node:fs";
import type { FilterOperators, OperationSpec } from "@ghxstship/xos-sdk";
import { FILTER_OPERATORS, OPERATIONS, RESOURCES } from "@ghxstship/xos-sdk";
import type { Io } from "./io.ts";
import { UsageError } from "./io.ts";

/** `purchase-orders` or `purchaseOrders` to the operation id segment `purchaseOrders`. */
export function toCamel(value: string): string {
  return value.replace(/[-_]+([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

export function findOperation(resource: string, verb: string): OperationSpec {
  const id = `${toCamel(resource)}.${toCamel(verb)}`;
  const spec = (OPERATIONS as Readonly<Record<string, OperationSpec>>)[id];
  if (spec) return spec;
  const known = RESOURCES.find((r) => r.name === toCamel(resource));
  if (!known)
    throw new UsageError(`Unknown resource "${resource}". Run \`xos resources\` to list them.`);
  const verbs = known.operations.map((o) => o.split(".")[1]).join(", ");
  throw new UsageError(`${known.name} has no "${verb}" operation. It has: ${verbs}.`);
}

export function operationById(id: string): OperationSpec {
  const spec = (OPERATIONS as Readonly<Record<string, OperationSpec>>)[id];
  if (!spec)
    throw new UsageError(`Unknown operation "${id}". Operation ids look like projects.list.`);
  return spec;
}

/** `field.op=value` pairs into the filter object. */
export function parseFilters(values: readonly string[]): Record<string, FilterOperators> {
  const filter: Record<string, Record<string, string | boolean>> = {};
  for (const raw of values) {
    const m = /^([a-z_][a-z0-9_]*)\.([a-z_]+)=(.*)$/s.exec(raw);
    if (!m)
      throw new UsageError(
        `--filter takes field.op=value, for example project_state.eq=Active; got "${raw}".`,
      );
    const [, field, op, value] = m as unknown as [string, string, string, string];
    if (!(FILTER_OPERATORS as readonly string[]).includes(op)) {
      throw new UsageError(`Unknown filter operator "${op}". Use ${FILTER_OPERATORS.join(", ")}.`);
    }
    filter[field] = { ...filter[field], [op]: op === "is_null" ? value === "true" : value };
  }
  return filter as Record<string, FilterOperators>;
}

/** `name=value` pairs. */
export function parsePairs(values: readonly string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of values) {
    const i = raw.indexOf("=");
    if (i < 1) throw new UsageError(`${flag} takes name=value; got "${raw}".`);
    out[raw.slice(0, i)] = raw.slice(i + 1);
  }
  return out;
}

/** `--data` as inline JSON, `@path` for a file or `-` for standard input. */
export async function parseData(value: string | undefined, io: Io): Promise<unknown> {
  if (value === undefined) return undefined;
  const text =
    value === "-"
      ? await io.readStdin()
      : value.startsWith("@")
        ? readFileSync(value.slice(1), "utf8")
        : value;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`--data is not valid JSON: ${(error as Error).message}`);
  }
}

export function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 200)
    throw new UsageError("--limit takes an integer from 1 to 200.");
  return n;
}
