/** Serializes paths and query strings exactly as ADR 0003 specifies. */
import type { FilterOperators, OperationSpec, QueryInput } from "./types.ts";
import { FILTER_OPERATORS } from "./types.ts";

const FIELD = /^[a-z_][a-z0-9_]*$/;

function scalar(value: unknown, where: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new TypeError(`${where} must be a string, a finite number or a boolean.`);
}

function list(value: readonly unknown[] | string, where: string): string {
  return typeof value === "string" ? value : value.map((v) => scalar(v, where)).join(",");
}

/** Appends `filter[field][op]=value` pairs, in the order the caller wrote them. */
export function appendFilter(
  params: URLSearchParams,
  filter: Readonly<Record<string, FilterOperators>>,
): void {
  for (const [field, ops] of Object.entries(filter)) {
    if (!FIELD.test(field)) throw new TypeError(`Filter field "${field}" is not a field name.`);
    for (const [op, value] of Object.entries(ops)) {
      if (value === undefined) continue;
      if (!(FILTER_OPERATORS as readonly string[]).includes(op)) {
        throw new TypeError(
          `Filter operator "${op}" on "${field}" is not one of ${FILTER_OPERATORS.join(", ")}.`,
        );
      }
      const where = `filter[${field}][${op}]`;
      const text = Array.isArray(value) ? list(value, where) : scalar(value, where);
      params.append(where, text);
    }
  }
}

export function buildQuery(spec: OperationSpec, input: object | undefined): URLSearchParams {
  const query = input as QueryInput | undefined;
  const params = new URLSearchParams();
  for (const name of spec.requiredQueryParams) {
    if (query?.[name] === undefined) {
      throw new TypeError(`${spec.id} requires the query parameter "${name}".`);
    }
  }
  if (!query) return params;
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue;
    switch (name) {
      case "limit":
      case "cursor":
      case "sort":
      case "filter":
        if (!spec.paged)
          throw new TypeError(`${spec.id} is not a paged list; "${name}" does not apply.`);
        break;
      case "fields":
        if (!spec.fields) throw new TypeError(`${spec.id} does not accept a sparse fieldset.`);
        break;
      default:
        if (!spec.queryParams.includes(name)) {
          throw new TypeError(`${spec.id} has no query parameter "${name}".`);
        }
    }
    if (name === "filter") {
      appendFilter(params, value as Readonly<Record<string, FilterOperators>>);
    } else if (name === "fields" || name === "sort") {
      params.append(name, list(value as readonly unknown[] | string, name));
    } else {
      params.append(name, scalar(value, name));
    }
  }
  return params;
}

export function buildPath(
  spec: OperationSpec,
  path: Readonly<Record<string, string | number>> | undefined,
): string {
  return spec.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = path?.[name];
    if (value === undefined || value === "") {
      throw new TypeError(`${spec.id} requires the path parameter "${name}".`);
    }
    return encodeURIComponent(String(value));
  });
}
