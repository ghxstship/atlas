/**
 * List queries over PostgREST (ADR 0003): the `filter[field][op]` grammar, `sort`, sparse
 * fieldsets and keyset cursor pagination in one call.
 *
 *   "projects.list": async ({ query }, { db }) =>
 *     ok(await listPage(db.from("projects"), query, {
 *       columns: PROJECT_COLUMNS, key: "id", defaultOrder: ["created_at"],
 *     })),
 *
 * The cursor holds the sort-key values of the last row, so pages stay stable under inserts.
 * Sort keys should be non-null columns; the key is always the final tiebreaker.
 */
import { badRequest } from "../problem.ts";
import { decodeCursor, pageSize, selectColumns, toPage } from "./pagination.ts";
import type { Cursor, CursorValue, Page } from "./pagination.ts";

type FilterOp = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "is_null" | "contains";

export type FilterValue = Partial<Record<FilterOp, string>>;
export type Filter = Readonly<Record<string, FilterValue>>;

export interface OrderKey {
  readonly field: string;
  readonly ascending: boolean;
}

/** The PostgREST builder methods the helpers call. */
interface Builder {
  eq(column: string, value: string): Builder;
  neq(column: string, value: string): Builder;
  lt(column: string, value: string): Builder;
  lte(column: string, value: string): Builder;
  gt(column: string, value: string): Builder;
  gte(column: string, value: string): Builder;
  in(column: string, values: readonly string[]): Builder;
  is(column: string, value: null): Builder;
  not(column: string, operator: string, value: null): Builder;
  ilike(column: string, pattern: string): Builder;
  or(filters: string): Builder;
  order(column: string, options: { ascending: boolean }): Builder;
  limit(count: number): Builder;
  then: PromiseLike<{ data: unknown; error: unknown }>["then"];
}

function erase(builder: unknown): Builder {
  return builder as Builder;
}

/** Applies `filter[field][op]=value`. `allowed` lists the filterable fields; others are a 400. */
export function applyFilter<B>(
  builder: B,
  filter: Filter | undefined,
  allowed: readonly string[],
): B {
  let b = erase(builder);
  for (const [field, ops] of Object.entries(filter ?? {})) {
    if (!allowed.includes(field)) throw badRequest(`Filtering on ${field} is not supported.`);
    for (const [op, value] of Object.entries(ops) as [FilterOp, string][]) {
      switch (op) {
        case "eq":
          b = b.eq(field, value);
          break;
        case "ne":
          b = b.neq(field, value);
          break;
        case "lt":
          b = b.lt(field, value);
          break;
        case "lte":
          b = b.lte(field, value);
          break;
        case "gt":
          b = b.gt(field, value);
          break;
        case "gte":
          b = b.gte(field, value);
          break;
        case "in":
          b = b.in(
            field,
            value.split(",").map((v) => v.trim()),
          );
          break;
        case "is_null":
          if (value !== "true" && value !== "false") {
            throw badRequest(`filter[${field}][is_null] takes true or false.`);
          }
          b = value === "true" ? b.is(field, null) : b.not(field, "is", null);
          break;
        case "contains":
          b = b.ilike(field, `%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
          break;
      }
    }
  }
  return b as B;
}

/** The order for `sort` (`field,-other`), else the default; the key always ends it. */
export function orderFor(
  sort: string | undefined,
  allowed: readonly string[],
  defaultOrder: readonly string[],
  key: string,
): OrderKey[] {
  const requested =
    sort === undefined
      ? defaultOrder.map((field) => ({ field, ascending: true }))
      : sort.split(",").map((s) => ({ field: s.replace(/^-/, ""), ascending: !s.startsWith("-") }));
  for (const { field } of requested) {
    if (!allowed.includes(field)) throw badRequest(`Sorting on ${field} is not supported.`);
  }
  const unique = requested.filter((k, i) => requested.findIndex((o) => o.field === k.field) === i);
  return unique.some((k) => k.field === key)
    ? unique
    : [...unique, { field: key, ascending: true }];
}

/** A PostgREST literal, quoted when it holds reserved characters. */
export function literal(value: CursorValue): string {
  if (value === null) return "null";
  const text = String(value);
  return /[,.:()"\\\s]/.test(text) ? `"${text.replace(/["\\]/g, (m) => `\\${m}`)}"` : text;
}

/** The `or` filter that selects rows after `cursor` in `order` (keyset pagination). */
export function keysetFilter(order: readonly OrderKey[], cursor: Cursor): string {
  const branches = order.map((key, i) => {
    const equal = order.slice(0, i).map((k) => `${k.field}.eq.${literal(cursor[k.field] ?? null)}`);
    const step = `${key.field}.${key.ascending ? "gt" : "lt"}.${literal(cursor[key.field] ?? null)}`;
    return equal.length === 0 ? step : `and(${[...equal, step].join(",")})`;
  });
  return branches.join(",");
}

export interface ListSpec {
  /** Columns of the read shape, in contract order. */
  readonly columns: readonly string[];
  /** The identifying column, always returned and the final sort tiebreaker. */
  readonly key: string;
  /** The documented default order (`x-xos-order`). */
  readonly defaultOrder: readonly string[];
  /** Filterable fields; defaults to every column. */
  readonly filterable?: readonly string[];
  /** Sortable fields; defaults to every column. */
  readonly sortable?: readonly string[];
}

export interface ListQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly fields?: string;
  readonly sort?: string;
  readonly filter?: Filter;
  /** Archived rows of an archivable resource (A124): absent leaves them out. */
  readonly archived?: "include" | "only";
}

/** Runs a list query and returns one cursor page, with sparse fieldsets applied. */
export async function listPage<T>(
  source: { select(columns: string): unknown },
  query: ListQuery,
  spec: ListSpec,
): Promise<Page<T>> {
  const size = pageSize(query.limit);
  const wanted = selectColumns(query.fields, spec.columns, spec.key);
  const order = orderFor(query.sort, spec.sortable ?? spec.columns, spec.defaultOrder, spec.key);
  const fetched = [...new Set([...wanted, ...order.map((k) => k.field)])];
  let b = erase(source.select(fetched.join(",")));
  b = applyFilter(b, query.filter, spec.filterable ?? spec.columns);
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(
      query.cursor,
      order.map((k) => k.field),
    );
    b = b.or(keysetFilter(order, cursor));
  }
  for (const k of order) b = b.order(k.field, { ascending: k.ascending });
  const { data, error } = await b.limit(size + 1);
  if (error !== null && error !== undefined) throw error;
  const rows = (data ?? []) as Record<string, CursorValue>[];
  const page = toPage(rows, size, (row) =>
    Object.fromEntries(order.map((k) => [k.field, row[k.field] ?? null])),
  );
  const extra = fetched.filter((f) => !wanted.includes(f));
  return {
    data: (extra.length === 0
      ? page.data
      : page.data.map((row) =>
          Object.fromEntries(Object.entries(row).filter(([k]) => !extra.includes(k))),
        )) as T[],
    next_cursor: page.next_cursor,
  };
}
