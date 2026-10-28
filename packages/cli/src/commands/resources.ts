/**
 * `xos resources`, `xos ops <resource>`, `xos call <operationId>` and the shorthand
 * `xos <resource> <verb> [path params...]`. Every operation in the OpenAPI document is
 * reachable; the operation table comes from the generated SDK.
 */
import { parseArgs } from "node:util";
import type { OperationSpec, RequestInput } from "@ghxstship/xos-sdk";
import { OPERATIONS, RESOURCES, TAGS } from "@ghxstship/xos-sdk";
import {
  findOperation,
  operationById,
  parseData,
  parseFilters,
  parseLimit,
  parsePairs,
  toCamel,
} from "../args.ts";
import type { Context } from "../context.ts";
import { UsageError } from "../io.ts";
import { render } from "../output.ts";

export function listResources(ctx: Context, argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], options: { tag: { type: "string" } } });
  if (values.tag && !TAGS.some((t) => t.name === values.tag)) {
    throw new UsageError(
      `Unknown module "${values.tag}". Modules: ${TAGS.map((t) => t.name).join(", ")}.`,
    );
  }
  const rows = RESOURCES.filter((r) => !values.tag || r.tag === values.tag).map((r) => ({
    resource: r.name,
    module: r.tag,
    operations: r.operations.map((o) => o.split(".")[1]).join(" "),
  }));
  render(ctx.io, ctx.format, rows, "resource,module,operations");
  return 0;
}

export function listOperations(ctx: Context, argv: readonly string[]): number {
  const name = argv[0];
  if (!name) throw new UsageError("Name a resource: `xos ops projects`.");
  const resource = RESOURCES.find((r) => r.name === toCamel(name));
  if (!resource)
    throw new UsageError(`Unknown resource "${name}". Run \`xos resources\` to list them.`);
  const rows = resource.operations.map((id) => {
    const op = OPERATIONS[id];
    return {
      operation: id,
      method: op.method,
      path: op.path,
      capability: op.capability,
      summary: op.summary,
    };
  });
  render(ctx.io, ctx.format, rows, "operation,method,path,capability,summary");
  return 0;
}

const CALL_OPTIONS = {
  path: { type: "string", multiple: true },
  query: { type: "string", multiple: true },
  filter: { type: "string", multiple: true },
  fields: { type: "string" },
  sort: { type: "string" },
  limit: { type: "string" },
  cursor: { type: "string" },
  all: { type: "boolean", default: false },
  data: { type: "string" },
  "if-match": { type: "string" },
  "idempotency-key": { type: "string" },
} as const;

/** Builds the request for one operation from positional path values and flags. */
export async function buildRequest(
  ctx: Context,
  spec: OperationSpec,
  positionals: readonly string[],
  values: {
    readonly path?: string[] | undefined;
    readonly query?: string[] | undefined;
    readonly filter?: string[] | undefined;
    readonly fields?: string | undefined;
    readonly sort?: string | undefined;
    readonly limit?: string | undefined;
    readonly cursor?: string | undefined;
    readonly data?: string | undefined;
  },
): Promise<RequestInput> {
  const path: Record<string, string> = parsePairs(values.path ?? [], "--path");
  if (positionals.length > spec.pathParams.length) {
    throw new UsageError(
      `${spec.id} takes ${spec.pathParams.length} path value(s): ${spec.pathParams.join(", ") || "none"}.`,
    );
  }
  positionals.forEach((value, i) => (path[spec.pathParams[i] as string] = value));
  const missing = spec.pathParams.filter((p) => path[p] === undefined);
  if (missing.length > 0)
    throw new UsageError(
      `${spec.id} needs ${missing.join(", ")}: \`xos ${spec.resource} ${spec.verb} <${missing.join("> <")}>\`.`,
    );

  const query: Record<string, unknown> = { ...parsePairs(values.query ?? [], "--query") };
  if (values.filter?.length) query["filter"] = parseFilters(values.filter);
  if (values.fields) query["fields"] = values.fields;
  if (values.sort) query["sort"] = values.sort;
  const limit = parseLimit(values.limit);
  if (limit !== undefined) query["limit"] = limit;
  if (values.cursor) query["cursor"] = values.cursor;

  const body = await parseData(values.data, ctx.io);
  return { path, query, ...(body !== undefined ? { body } : {}) };
}

async function execute(
  ctx: Context,
  spec: OperationSpec,
  positionals: readonly string[],
  argv: readonly string[],
): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: CALL_OPTIONS, allowPositionals: false });
  const input = await buildRequest(ctx, spec, positionals, values);
  const client = ctx.client();

  if (spec.paged) {
    if (values.all) {
      const rows: unknown[] = [];
      for await (const row of client.paginate(spec, input)) rows.push(row);
      render(ctx.io, ctx.format, rows, values.fields);
    } else {
      const page = await client.requestPage(spec, input);
      render(
        ctx.io,
        ctx.format,
        ctx.format === "json" ? { data: page.data, next_cursor: page.nextCursor } : page.data,
        values.fields,
      );
      if (ctx.format === "table" && page.nextCursor) {
        ctx.io.stderr(
          `More rows: add --cursor ${page.nextCursor}, or --all to fetch every page.\n`,
        );
      }
    }
    return 0;
  }
  if (values.all) throw new UsageError(`${spec.id} is not a list; --all does not apply.`);

  let ifMatch = values["if-match"];
  if (spec.ifMatch && !ifMatch) {
    throw new UsageError(
      `${spec.id} needs --if-match with the ETag you read, or --if-match auto to read it first.`,
    );
  }
  if (spec.ifMatch && ifMatch === "auto") {
    const getter = (OPERATIONS as Readonly<Record<string, OperationSpec>>)[`${spec.resource}.get`];
    if (!getter)
      throw new UsageError(`${spec.resource} has no get operation; pass the ETag to --if-match.`);
    ifMatch = (await client.request(getter, { path: input.path ?? {} })).etag ?? undefined;
    if (!ifMatch) throw new UsageError(`${getter.id} returned no ETag; pass one to --if-match.`);
  }
  const response = await client.request(spec, input, {
    ...(ifMatch ? { ifMatch } : {}),
    ...(values["idempotency-key"] ? { idempotencyKey: values["idempotency-key"] } : {}),
  });
  if (response.etag && ctx.format === "table") ctx.io.stderr(`ETag: ${response.etag}\n`);
  if (response.data === undefined) {
    ctx.io.stderr(`${spec.summary}: done (${response.status}).\n`);
  } else {
    render(ctx.io, ctx.format, response.data, values.fields);
  }
  return 0;
}

export async function call(ctx: Context, argv: readonly string[]): Promise<number> {
  const [id, ...rest] = argv;
  if (!id) throw new UsageError("Name an operation: `xos call projects.list`.");
  const spec = operationById(id);
  const positionals: string[] = [];
  while (rest[0] !== undefined && !rest[0].startsWith("--"))
    positionals.push(rest.shift() as string);
  return execute(ctx, spec, positionals, rest);
}

export async function resourceCommand(
  ctx: Context,
  resource: string,
  argv: readonly string[],
): Promise<number> {
  const [verb, ...rest] = argv;
  if (!verb) {
    return listOperations(ctx, [resource]);
  }
  const spec = findOperation(resource, verb);
  const positionals: string[] = [];
  while (rest[0] !== undefined && !rest[0].startsWith("--"))
    positionals.push(rest.shift() as string);
  return execute(ctx, spec, positionals, rest);
}
