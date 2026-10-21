/**
 * Table-backed handlers (A04P, API parity). Many v1 resources are one table read and written as
 * the caller: list, get, create, update and delete map onto PostgREST calls, and row level
 * security, the column guards and the lifecycle triggers decide every refusal. `tableHandlers`
 * builds those operations from the corrected catalog (ADR 0023), so the selected columns are the
 * resource's read shape, the accepted fields its create and update bodies, and the default order
 * its documented `x-xos-order`.
 *
 *   export const handlers = defineHandlers("Show", {
 *     ...tableHandlers("Show", "runsOfShow"),
 *     "cues.fire": async (...) => ...,
 *   });
 *
 * A resource whose contract names differ from its columns passes `aliases`; one whose create body
 * lacks a NOT NULL column derived from a parent passes `beforeCreate`; one whose read shape holds a
 * derived field passes `extraColumns` and `toContract`.
 */
import type { DataError, XosClient } from "@xos/data";
import { atlasResources } from "../../catalog/atlas.ts";
import { canonResources } from "../../catalog/canon.ts";
import { marketplaceResources } from "../../catalog/marketplace.ts";
import { platformResources } from "../../catalog/platform.ts";
import { applyAdditions } from "../../catalog/additions.ts";
import {
  CONTRACT_CORRECTIONS,
  applyCorrections,
  resolveCorrections,
} from "../../catalog/corrections.ts";
import { MODULE_ADDITIONS } from "../../catalog/modules/index.generated.ts";
import type { Module, ResourceSpec, Verb } from "../../catalog/types.ts";
import { conflict, notFound, preconditionFailed, refused } from "../../problem.ts";
import type { RequestContext } from "../../runtime/context.ts";
import { assertIfMatch, versionFromIfMatch } from "../../runtime/etag.ts";
import type { ErasedHandler, ErasedRequest, HandlerSet } from "../../runtime/handler.ts";
import { created, noContent, ok } from "../../runtime/handler.ts";
import type { ListQuery } from "../../runtime/listing.ts";
import { listPage } from "../../runtime/listing.ts";
import type { Page } from "../../runtime/pagination.ts";
import { selectColumns } from "../../runtime/pagination.ts";

export type Row = Record<string, unknown>;
type Enrich = (rows: Row[], context: RequestContext) => Promise<Row[]>;

// The corrected catalog -----------------------------------------------------------------------------

let specs: ReadonlyMap<string, ResourceSpec> | undefined;

/**
 * The corrected catalog resource for `op`. Built on first use from the same sources as `app.ts`,
 * which cannot be imported here: it imports every handler file.
 */
export function resourceSpec(op: string): ResourceSpec {
  if (specs === undefined) {
    const frozen = [
      ...atlasResources,
      ...marketplaceResources,
      ...canonResources,
      ...platformResources,
    ];
    const corrections = resolveCorrections(frozen, [
      ...CONTRACT_CORRECTIONS,
      ...MODULE_ADDITIONS.flatMap((m) => m.corrections),
    ]);
    const all = applyAdditions(applyCorrections(frozen, corrections), MODULE_ADDITIONS);
    specs = new Map(all.map((s) => [s.op, s]));
  }
  const spec = specs.get(op);
  if (spec === undefined) throw new Error(`${op} is not a catalog resource.`);
  return spec;
}

/** The PostgREST schema and relation of a resource's `schema.table` source. */
export function relationOf(spec: ResourceSpec): { schema: string; table: string } {
  const [schema, table] = spec.def.table.split(".");
  return { schema: schema as string, table: table as string };
}

/** The read shape's fields, in contract order. */
export function readFields(spec: ResourceSpec): string[] {
  return Object.keys(spec.def.read.shape);
}

// Builders --------------------------------------------------------------------------------------------

/** The PostgREST builder calls the table handlers make, with the generated types erased. */
export interface Query extends PromiseLike<{ data: unknown; error: unknown }> {
  select(columns: string, options?: { head?: boolean; count?: "exact" }): Query;
  insert(values: Row | readonly Row[]): Query;
  update(values: Row): Query;
  delete(): Query;
  eq(column: string, value: unknown): Query;
  neq(column: string, value: unknown): Query;
  is(column: string, value: null | boolean): Query;
  in(column: string, values: readonly unknown[]): Query;
  gt(column: string, value: unknown): Query;
  gte(column: string, value: unknown): Query;
  lt(column: string, value: unknown): Query;
  lte(column: string, value: unknown): Query;
  or(filter: string): Query;
  order(column: string, options: { ascending: boolean }): Query;
  limit(count: number): Query;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
  single(): PromiseLike<{ data: unknown; error: unknown }>;
}

/** `db.from(table)` in a schema, with the generated types erased. */
export function from(db: XosClient, table: string, schema = "app"): Query {
  const client = (schema === "app" ? db : db.schema(schema as "app")) as unknown as {
    from(t: string): Query;
  };
  return client.from(table);
}

/** `db.rpc(name, args)` with the generated types erased, for RPCs any module may add. */
export function rpc(
  db: XosClient,
  name: string,
  args: Row = {},
): PromiseLike<{ data: unknown; error: unknown }> {
  // Cast the client, not db.rpc.bind(db), which instantiates every generated function type (TS2589).
  const untyped = db as unknown as {
    rpc(fn: string, params: Row): PromiseLike<{ data: unknown; error: unknown }>;
  };
  return untyped.rpc(name, args);
}

/** Awaits a query and throws its error, so the runtime maps it (README "Errors"). */
export async function run<T = unknown>(
  query: PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T> {
  const { data, error } = await query;
  if (error !== null && error !== undefined) throw error;
  return data as T;
}

/** A repository error as an API problem (README "Errors"). */
export function problemFor(error: DataError): Error {
  switch (error.kind) {
    case "refusal":
      return refused("REFUSE", error.message, error.rule);
    case "not-found":
      return notFound();
    case "conflict":
      return conflict(error.message);
    case "invalid":
      return refused("REFUSE", error.message, "invalid_value");
    case "unexpected":
      return new Error(error.message);
  }
}

/** Unwraps a repository `Result`, throwing its error as a problem. */
export function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: DataError }): T {
  if (!result.ok) throw problemFor(result.error);
  return result.data;
}

/** Filter and order methods whose first argument names a column. */
const COLUMN_METHODS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "not",
  "order",
]);

/**
 * A list source whose contract field names differ from the table's columns. `select` asks
 * PostgREST for `field:column`, and every filter, order and keyset `or` the listing applies is
 * rewritten to the column, so `listPage` works in contract names end to end.
 */
export function aliasedSource(
  start: () => { select(columns: string): unknown },
  aliases: Readonly<Record<string, string>>,
): { select(columns: string): unknown } {
  if (Object.keys(aliases).length === 0) return { select: (c) => start().select(c) };
  const column = (field: string) => aliases[field] ?? field;
  const rewriteOr = (filter: string) =>
    filter.replace(
      /(^|[(,])([a-z_0-9]+)\./g,
      (_, lead: string, field: string) => `${lead}${column(field)}.`,
    );
  const wrap = (builder: unknown): unknown =>
    new Proxy(builder as Row, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        if (prop === "then") return (value as (...a: unknown[]) => unknown).bind(target);
        return (...args: unknown[]) => {
          if (typeof prop === "string" && COLUMN_METHODS.has(prop) && typeof args[0] === "string") {
            args[0] = column(args[0]);
          } else if (prop === "or" && typeof args[0] === "string") {
            args[0] = rewriteOr(args[0]);
          }
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          return result !== null && typeof result === "object" ? wrap(result) : result;
        };
      },
    });
  return {
    select(columns: string) {
      return wrap(start().select(selectList(columns.split(","), aliases)));
    },
  };
}

/** `field:column` for aliased fields, joined for `select`. */
export function selectList(
  fields: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
): string {
  return fields.map((f) => (aliases[f] === undefined ? f : `${f}:${aliases[f]}`)).join(",");
}

/** Contract fields of a body renamed to their columns, leaving out absent members. */
export function toColumns(
  body: unknown,
  fields: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
): Row {
  const source = (body ?? {}) as Row;
  const out: Row = {};
  for (const field of fields) {
    if (source[field] === undefined) continue;
    out[aliases[field] ?? field] = source[field];
  }
  return out;
}

/** A list query with `sort` set when there is one. */
export function withSort(query: ListQuery, sort: string | undefined): ListQuery {
  return sort === undefined ? query : { ...query, sort };
}

/** The default order of a resource as a `sort` value, descending for a feed. */
export function defaultSort(spec: ResourceSpec): string | undefined {
  if (spec.order.descending !== true) return undefined;
  return spec.order.by.map((f) => `-${f}`).join(",");
}

// Table handlers --------------------------------------------------------------------------------------

export interface TableOptions {
  /** The operations to build; defaults to every verb of the resource. */
  readonly verbs?: readonly Verb[];
  /**
   * The table soft-deletes with `deleted_at`: lists and reads leave deleted rows out and delete
   * sets `deleted_at`. Defaults to true; false deletes the row.
   */
  readonly softDelete?: boolean;
  /** Contract field to column, where they differ. */
  readonly aliases?: Readonly<Record<string, string>>;
  /** Read fields the table does not hold, filled by `toContract`. */
  readonly derived?: readonly string[];
  /** Columns `toContract` needs beyond the read shape. */
  readonly extraColumns?: readonly string[];
  /** Maps a row read from the table to the contract shape. */
  readonly toContract?: (row: Row, context: RequestContext) => Row | Promise<Row>;
  /**
   * Adds derived fields to the rows of a page (or the one row of a read) in one pass, before
   * `toContract`: a sidecar or view read once per page with `in`, never once per row.
   */
  readonly enrich?: (rows: Row[], context: RequestContext) => Promise<Row[]>;
  /** Columns the insert sets beyond the create body, such as a parent reference. */
  readonly beforeCreate?: (body: Row, context: RequestContext) => Row | Promise<Row>;
  /** Columns the update sets beyond the update body, or a check that may refuse it. */
  readonly beforeUpdate?: (body: Row, current: Row, context: RequestContext) => Row | Promise<Row>;
  /**
   * Update fields the caller may not change (no column grant): sending one is refused with 422
   * instead of reaching the database as a permission error.
   */
  readonly fixed?: readonly string[];
  /**
   * Whether the insert carries `org_id` from the credential; defaults to tenant resources. Pass
   * false where the insert grant leaves `org_id` out and the database derives it.
   */
  readonly orgColumn?: boolean;
  /** Narrows lists and reads beyond RLS, such as to the caller's own rows. */
  readonly scope?: (query: Query, context: RequestContext) => Query;
  /**
   * The identifying field for a keyless view, used as the final sort tiebreaker; defaults to the
   * first field of the documented order. Pass a field that is unique together with the order.
   */
  readonly key?: string;
  /** Sortable and filterable fields; defaults to every stored read field. */
  readonly sortable?: readonly string[];
}

/** The table handlers of a resource, plus helpers its custom actions reuse. */
export interface TableResource {
  readonly spec: ResourceSpec;
  readonly fields: readonly string[];
  readonly key: string;
  /** Reads one visible row in the contract shape, or throws 404. */
  read(context: RequestContext, id: string, fields?: readonly string[]): Promise<Row>;
  /** One page of rows in the contract shape. */
  list(context: RequestContext, query: ListQuery): Promise<Page<Row>>;
  /** The source query, scoped and with deleted rows left out. */
  source(context: RequestContext): Query;
  readonly handlers: Readonly<Record<string, ErasedHandler>>;
}

export function tableResource(op: string, options: TableOptions = {}): TableResource {
  const spec = resourceSpec(op);
  const { schema, table } = relationOf(spec);
  const aliases = options.aliases ?? {};
  const derived = new Set(options.derived ?? []);
  const fields = readFields(spec);
  const stored = fields.filter((f) => !derived.has(f));
  const key = options.key ?? (spec.def.key === "" ? (spec.order.by[0] as string) : spec.def.key);
  const soft = options.softDelete ?? true;
  const extra = options.extraColumns ?? [];
  const createFields = Object.keys(spec.def.create?.shape ?? {});
  const updateFields = Object.keys(spec.def.update?.shape ?? {});
  const withOrg = options.orgColumn ?? spec.def.base === "tenant";

  const source = (context: RequestContext): Query => from(context.db, table, schema);
  const scoped = (context: RequestContext, q: Query): Query => {
    let out = soft ? q.is("deleted_at", null) : q;
    if (options.scope !== undefined) out = options.scope(out, context);
    return out;
  };
  /** Whether the read asks for a derived field, so the page needs its enrichment. */
  const enriches = (wanted: readonly string[]) =>
    options.enrich !== undefined && wanted.some((f) => derived.has(f));
  const shape = async (context: RequestContext, row: Row, wanted: readonly string[]) => {
    const mapped = options.toContract === undefined ? row : await options.toContract(row, context);
    return Object.fromEntries(wanted.map((f) => [f, mapped[f] ?? null]));
  };

  const read = async (context: RequestContext, id: string, wanted: readonly string[] = fields) => {
    const columns = [...new Set([...wanted.filter((f) => !derived.has(f)), ...extra])];
    const q = scoped(context, source(context).select(selectList(columns, aliases))).eq(
      aliases[key] ?? key,
      id,
    );
    const row = await run<Row | null>(q.maybeSingle());
    if (row === null) throw notFound(`No ${spec.label} with this identifier is visible to you.`);
    const [enriched] = enriches(wanted) ? await (options.enrich as Enrich)([row], context) : [row];
    return shape(context, enriched ?? row, wanted);
  };

  const list = async (context: RequestContext, query: ListQuery) => {
    const wanted = selectColumns(query.fields, fields, key);
    const sortable = options.sortable ?? stored;
    const page = await listPage<Row>(
      aliasedSource(
        () => ({
          select: (columns: string) => {
            const all = [...new Set([...columns.split(","), ...extra])].filter(
              (c) => c !== "" && !derived.has(c.split(":")[0] as string),
            );
            return scoped(context, source(context).select(all.join(",")));
          },
        }),
        aliases,
      ),
      withSort(
        { ...query, fields: wanted.filter((f) => !derived.has(f)).join(",") },
        query.sort ?? defaultSort(spec),
      ),
      {
        columns: stored,
        key,
        defaultOrder: spec.order.by,
        sortable,
        filterable: sortable,
      },
    );
    const rows = enriches(wanted)
      ? await (options.enrich as Enrich)(page.data, context)
      : page.data;
    const data = await Promise.all(rows.map((row) => shape(context, row, wanted)));
    return { data, next_cursor: page.next_cursor };
  };

  const handlers: Record<string, ErasedHandler> = {};
  const verbs = options.verbs ?? spec.verbs;
  const has = (v: Verb) => verbs.includes(v) && spec.verbs.includes(v);

  if (has("list")) {
    handlers[`${op}.list`] = async (request, context) =>
      ok(await list(context, request.query as ListQuery));
  }
  if (has("get")) {
    handlers[`${op}.get`] = async (request, context) =>
      ok(
        await read(
          context,
          paramOf(request, spec),
          selectColumns(request.query["fields"] as string | undefined, fields, key),
        ),
      );
  }
  if (has("create")) {
    handlers[`${op}.create`] = async (request, context) => {
      const body = (request.body ?? {}) as Row;
      const values: Row = {
        // The credential's organization; a parent-derived org_id (derive_org_id) overrides it,
        // so a caller without an active organization (an external party) can still create.
        ...(withOrg && context.org !== null ? { org_id: context.org.id } : {}),
        ...toColumns(body, createFields, aliases),
        ...(options.beforeCreate === undefined ? {} : await options.beforeCreate(body, context)),
      };
      const inserted = await run<Row>(
        source(context)
          .insert(values)
          .select(aliases[key] ?? key)
          .single(),
      );
      return created(await read(context, String(inserted[aliases[key] ?? key])));
    };
  }
  if (has("update")) {
    handlers[`${op}.update`] = async (request, context) => {
      const id = paramOf(request, spec);
      const body = (request.body ?? {}) as Row;
      const ifMatch = request.ifMatch ?? "*";
      const blocked = (options.fixed ?? []).filter((f) => body[f] !== undefined);
      if (blocked.length > 0) {
        throw refused(
          "REFUSE",
          `${blocked.join(", ")} cannot change after the ${spec.label} is created.`,
          "field_immutable",
        );
      }
      const current = await read(context, id);
      const patch: Row = {
        ...toColumns(body, updateFields, aliases),
        ...(options.beforeUpdate === undefined
          ? {}
          : await options.beforeUpdate(body, current, context)),
      };
      if (Object.keys(patch).length === 0) {
        assertIfMatch(ifMatch, current);
        return ok(current);
      }
      const version = versionFromIfMatch(ifMatch);
      let q = scoped(context, source(context).update(patch)).eq(aliases[key] ?? key, id);
      if (version !== null) q = q.eq("updated_at", version);
      const rows = await run<Row[] | null>(q.select(aliases[key] ?? key));
      if (rows === null || rows.length === 0) throw preconditionFailed();
      return ok(await read(context, id));
    };
  }
  if (has("delete")) {
    handlers[`${op}.delete`] = async (request, context) => {
      const id = paramOf(request, spec);
      await read(context, id, [key]);
      const column = aliases[key] ?? key;
      if (soft) {
        await run(
          source(context)
            .update({ deleted_at: new Date().toISOString() })
            .eq(column, id)
            .is("deleted_at", null),
        );
      } else {
        await run(source(context).delete().eq(column, id));
      }
      return noContent();
    };
  }

  return { spec, fields, key, read, list, source: (c) => scoped(c, source(c)), handlers };
}

/**
 * Rows of `query` grouped by `column`, for enriching a page: the caller narrows the query to the
 * page's keys with `in`. Groups keep the query's order.
 */
export async function groupBy(query: Query, column: string): Promise<Map<string, Row[]>> {
  const rows = await run<Row[] | null>(query);
  const out = new Map<string, Row[]>();
  for (const row of rows ?? []) {
    const key = String(row[column]);
    out.set(key, [...(out.get(key) ?? []), row]);
  }
  return out;
}

/** The distinct string values of `column` across rows, for an `in` filter. */
export function keysOf(rows: readonly Row[], column: string): string[] {
  return [...new Set(rows.map((r) => r[column]).filter((v): v is string => typeof v === "string"))];
}

/** The item path parameter of a request. */
export function paramOf(request: ErasedRequest, spec: ResourceSpec): string {
  return String(request.params[spec.keyParam] ?? request.params["id"]);
}

/** The handlers of a table-backed resource, typed for the module's handler set. */
export function tableHandlers<M extends Module>(
  _module: M,
  op: string,
  options: TableOptions = {},
): HandlerSet<M> {
  return tableResource(op, options).handlers as unknown as HandlerSet<M>;
}

/** The handlers of a table resource built with `tableResource`, typed for the module. */
export function handlersFor<M extends Module>(_module: M, resource: TableResource): HandlerSet<M> {
  return resource.handlers as unknown as HandlerSet<M>;
}
