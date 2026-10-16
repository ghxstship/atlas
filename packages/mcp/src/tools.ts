/**
 * The XOS tools. Every call goes through the public API with the configured API key, so an
 * agent can never do more than the key allows; the API enforces capabilities, RLS, field
 * masking, separation of duties and refusals. On top of that, write tools exist only when the
 * operator opts in, and only for the resources or modules named in the write scope.
 */
import type { OperationSpec, XosClient } from "@xos/sdk";
import { OPERATIONS, RESOURCES, TAGS, XosApiError, XosNetworkError } from "@xos/sdk";
import type { ToolDefinition, ToolProvider, ToolResult } from "./protocol.ts";
import { InvalidParams } from "./protocol.ts";

const SPECS = OPERATIONS as Readonly<Record<string, OperationSpec>>;

export interface WriteScope {
  readonly all: boolean;
  readonly resources: ReadonlySet<string>;
  readonly modules: ReadonlySet<string>;
  readonly allowDelete: boolean;
}

export const READ_ONLY: WriteScope = {
  all: false,
  resources: new Set(),
  modules: new Set(),
  allowDelete: false,
};

function toCamel(value: string): string {
  return value.replace(/[-_]+([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** `all`, or a comma-separated list of resources (`purchaseOrders`, `purchase-orders`) and modules (`Finance`). */
export function parseWriteScope(spec: string | undefined, allowDelete: boolean): WriteScope {
  const entries = (spec ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return { ...READ_ONLY, allowDelete: false };
  if (entries.includes("all"))
    return { all: true, resources: new Set(), modules: new Set(), allowDelete };
  const resources = new Set<string>();
  const modules = new Set<string>();
  for (const entry of entries) {
    const tag = TAGS.find((t) => t.name.toLowerCase() === entry.toLowerCase());
    if (tag) {
      modules.add(tag.name);
      continue;
    }
    const resource = RESOURCES.find((r) => r.name === toCamel(entry));
    if (!resource)
      throw new Error(`Write scope entry "${entry}" is neither a resource nor a module.`);
    resources.add(resource.name);
  }
  return { all: false, resources, modules, allowDelete };
}

export function canWrite(scope: WriteScope, spec: OperationSpec): boolean {
  if (spec.method === "GET") return true;
  if (spec.method === "DELETE" && !scope.allowDelete) return false;
  return scope.all || scope.resources.has(spec.resource) || scope.modules.has(spec.tag);
}

function hasWrites(scope: WriteScope): boolean {
  return scope.all || scope.resources.size > 0 || scope.modules.size > 0;
}

const FILTER_SCHEMA = {
  type: "object",
  description:
    'Conditions on top-level fields, combined with AND: {"field": {"op": value}}. Operators: eq, ne, lt, lte, gt, gte, in (array or comma-separated), is_null (boolean), contains.',
  additionalProperties: {
    type: "object",
    properties: Object.fromEntries(
      ["eq", "ne", "lt", "lte", "gt", "gte", "in", "is_null", "contains"].map((op) => [op, {}]),
    ),
    additionalProperties: false,
  },
};
const PATH_SCHEMA = {
  type: "object",
  description: 'Path parameters by name, for example {"id": "..."} or {"dept_code": "4000"}.',
  additionalProperties: { type: ["string", "number"] },
};
const RESOURCE_SCHEMA = {
  type: "string",
  description: "Resource name from xos_list_resources, for example projects or purchaseOrders.",
};
const FIELDS_SCHEMA = {
  type: "string",
  description: "Sparse fieldset: comma-separated top-level fields. id is always returned.",
};

interface ToolContext {
  readonly client: XosClient;
  readonly scope: WriteScope;
  readonly fetchDocument: () => Promise<Record<string, unknown>>;
}

type Handler = (args: Readonly<Record<string, unknown>>, ctx: ToolContext) => Promise<unknown>;

interface Tool {
  readonly definition: ToolDefinition;
  readonly handler: Handler;
  readonly write: boolean;
}

function str(args: Readonly<Record<string, unknown>>, name: string, required: true): string;
function str(
  args: Readonly<Record<string, unknown>>,
  name: string,
  required: false,
): string | undefined;
function str(
  args: Readonly<Record<string, unknown>>,
  name: string,
  required: boolean,
): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value === "")
    throw new InvalidParams(`${name} must be a non-empty string.`);
  return value;
}

function obj(
  args: Readonly<Record<string, unknown>>,
  name: string,
): Record<string, unknown> | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new InvalidParams(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function operation(resource: string, verb: string): OperationSpec {
  const spec = SPECS[`${toCamel(resource)}.${verb}`];
  if (!spec)
    throw new InvalidParams(
      `${resource} has no ${verb} operation; call xos_list_resources to see what exists.`,
    );
  return spec;
}

function operationById(id: string): OperationSpec {
  const spec = SPECS[id];
  if (!spec)
    throw new InvalidParams(`Unknown operation ${id}; operation ids look like projects.get.`);
  return spec;
}

/** Path values from `path`, or `id` for the common single-identifier case. */
function pathFor(
  spec: OperationSpec,
  args: Readonly<Record<string, unknown>>,
): Record<string, string | number> {
  const path = { ...(obj(args, "path") ?? {}) } as Record<string, string | number>;
  const id = args["id"];
  if (
    id !== undefined &&
    spec.pathParams.length === 1 &&
    path[spec.pathParams[0] as string] === undefined
  ) {
    path[spec.pathParams[0] as string] = id as string;
  }
  const missing = spec.pathParams.filter((p) => path[p] === undefined);
  if (missing.length > 0)
    throw new InvalidParams(`${spec.id} needs path values for: ${missing.join(", ")}.`);
  return path;
}

function limitOf(args: Readonly<Record<string, unknown>>): number {
  const limit = args["limit"] ?? 25;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new InvalidParams("limit must be an integer from 1 to 200.");
  }
  return limit;
}

function requireWrite(ctx: ToolContext, spec: OperationSpec): void {
  if (!canWrite(ctx.scope, spec)) {
    throw new ScopeRefusal(
      `${spec.id} is outside this server's write scope. The operator can widen it with --write ${spec.resource} or --write ${spec.tag}${spec.method === "DELETE" ? " and --allow-delete" : ""}.`,
    );
  }
}

class ScopeRefusal extends Error {
  override name = "ScopeRefusal";
}

const TOOLS: readonly Tool[] = [
  {
    write: false,
    definition: {
      name: "xos_list_resources",
      title: "List XOS resources",
      description:
        "Lists API resources with their module and operations. Start here to find the resource and operation an action needs.",
      inputSchema: {
        type: "object",
        properties: {
          module: {
            type: "string",
            description: "Only resources in this module, for example Finance.",
          },
        },
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (args) => {
      const module = str(args, "module", false);
      if (module && !TAGS.some((t) => t.name === module)) {
        throw new InvalidParams(
          `Unknown module ${module}. Modules: ${TAGS.map((t) => t.name).join(", ")}.`,
        );
      }
      return {
        resources: RESOURCES.filter((r) => !module || r.tag === module).map((r) => ({
          resource: r.name,
          module: r.tag,
          operations: r.operations.map((id) => ({
            id,
            method: SPECS[id]?.method,
            summary: SPECS[id]?.summary,
          })),
        })),
      };
    },
  },
  {
    write: false,
    definition: {
      name: "xos_describe_operation",
      title: "Describe an operation",
      description:
        "Shows an operation's method, path, parameters, capability and its request and response schemas from the API's OpenAPI document.",
      inputSchema: {
        type: "object",
        properties: {
          operation_id: { type: "string", description: "For example purchaseOrders.approve." },
        },
        required: ["operation_id"],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (args, ctx) => {
      const spec = operationById(str(args, "operation_id", true));
      const doc = await ctx.fetchDocument();
      const schemas = ((doc["components"] as Record<string, unknown> | undefined)?.["schemas"] ??
        {}) as Record<string, unknown>;
      const pick = (name: string | null) => (name ? { name, schema: schemas[name] ?? null } : null);
      return {
        operation: spec,
        request_body: pick(spec.body),
        response: pick(spec.paged ? spec.item : spec.response),
      };
    },
  },
  {
    write: false,
    definition: {
      name: "xos_whoami",
      title: "Show the acting identity",
      description: "Returns the person and organization the API key acts as.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (_args, ctx) => (await ctx.client.me.get()).data,
  },
  {
    write: false,
    definition: {
      name: "xos_list",
      title: "List rows",
      description:
        "Lists one page of a resource with filters, sort and a sparse fieldset. Follow next_cursor for more. Money is integer minor units; null means unpriced.",
      inputSchema: {
        type: "object",
        properties: {
          resource: RESOURCE_SCHEMA,
          path: PATH_SCHEMA,
          filter: FILTER_SCHEMA,
          sort: {
            type: "string",
            description: "Comma-separated fields; a leading - sorts descending.",
          },
          fields: FIELDS_SCHEMA,
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Page size; default 25.",
          },
          cursor: { type: "string", description: "next_cursor from the previous page." },
        },
        required: ["resource"],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (args, ctx) => {
      const spec = operation(str(args, "resource", true), "list");
      const query = {
        limit: limitOf(args),
        ...(obj(args, "filter") ? { filter: obj(args, "filter") } : {}),
        ...(args["sort"] !== undefined ? { sort: str(args, "sort", true) } : {}),
        ...(args["fields"] !== undefined ? { fields: str(args, "fields", true) } : {}),
        ...(args["cursor"] !== undefined ? { cursor: str(args, "cursor", true) } : {}),
      };
      const page = await ctx.client.requestPage(spec, { path: pathFor(spec, args), query });
      return { data: page.data, next_cursor: page.nextCursor };
    },
  },
  {
    write: false,
    definition: {
      name: "xos_get",
      title: "Get a row",
      description:
        "Reads one row by identifier. The response includes etag, which xos_update needs as if_match.",
      inputSchema: {
        type: "object",
        properties: {
          resource: RESOURCE_SCHEMA,
          id: { type: ["string", "number"], description: "The row identifier." },
          path: PATH_SCHEMA,
          fields: FIELDS_SCHEMA,
        },
        required: ["resource"],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (args, ctx) => {
      const spec = operation(str(args, "resource", true), "get");
      const fields = str(args, "fields", false);
      const response = await ctx.client.request(spec, {
        path: pathFor(spec, args),
        ...(fields ? { query: { fields } } : {}),
      });
      return { data: response.data, etag: response.etag };
    },
  },
  {
    write: false,
    definition: {
      name: "xos_read",
      title: "Call a read operation",
      description:
        "Calls any GET operation by id, such as projects.gateReadiness, home.get or canonElements.resolve.",
      inputSchema: {
        type: "object",
        properties: {
          operation_id: { type: "string" },
          path: PATH_SCHEMA,
          query: {
            type: "object",
            description:
              "Query parameters, including filter, sort, fields, limit and cursor where the operation takes them.",
          },
        },
        required: ["operation_id"],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (args, ctx) => {
      const spec = operationById(str(args, "operation_id", true));
      if (spec.method !== "GET")
        throw new InvalidParams(
          `${spec.id} is not a read operation; use xos_create, xos_update, xos_action or xos_delete.`,
        );
      const input = { path: pathFor(spec, args), query: obj(args, "query") ?? {} };
      if (spec.paged) {
        const page = await ctx.client.requestPage(spec, input);
        return { data: page.data, next_cursor: page.nextCursor };
      }
      const response = await ctx.client.request(spec, input);
      return { data: response.data, etag: response.etag };
    },
  },
  {
    write: true,
    definition: {
      name: "xos_create",
      title: "Create a row",
      description:
        "Creates a row. Pass idempotency_key to make a retried call safe: a replay returns the original response instead of a second row.",
      inputSchema: {
        type: "object",
        properties: {
          resource: RESOURCE_SCHEMA,
          path: PATH_SCHEMA,
          body: { type: "object" },
          idempotency_key: { type: "string", minLength: 8, maxLength: 255 },
        },
        required: ["resource", "body"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: async (args, ctx) => {
      const spec = operation(str(args, "resource", true), "create");
      requireWrite(ctx, spec);
      const key = str(args, "idempotency_key", false);
      const response = await ctx.client.request(
        spec,
        { path: pathFor(spec, args), body: obj(args, "body") },
        key ? { idempotencyKey: key } : undefined,
      );
      return { data: response.data, etag: response.etag };
    },
  },
  {
    write: true,
    definition: {
      name: "xos_update",
      title: "Update a row",
      description:
        "Updates the fields sent. if_match must be the etag from xos_get; a stale etag fails, so read again and retry.",
      inputSchema: {
        type: "object",
        properties: {
          resource: RESOURCE_SCHEMA,
          id: { type: ["string", "number"] },
          path: PATH_SCHEMA,
          body: { type: "object" },
          if_match: { type: "string" },
        },
        required: ["resource", "body", "if_match"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: async (args, ctx) => {
      const spec = operation(str(args, "resource", true), "update");
      requireWrite(ctx, spec);
      const response = await ctx.client.request(
        spec,
        { path: pathFor(spec, args), body: obj(args, "body") },
        { ifMatch: str(args, "if_match", true) },
      );
      return { data: response.data, etag: response.etag };
    },
  },
  {
    write: true,
    definition: {
      name: "xos_action",
      title: "Run an action",
      description:
        "Runs a POST action by operation id, such as purchaseOrders.approve or records.transition. Transitions are compare-and-set on expected_state; a refusal explains why.",
      inputSchema: {
        type: "object",
        properties: {
          operation_id: { type: "string" },
          path: PATH_SCHEMA,
          id: { type: ["string", "number"] },
          body: { type: "object" },
          idempotency_key: { type: "string", minLength: 8, maxLength: 255 },
        },
        required: ["operation_id"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: async (args, ctx) => {
      const spec = operationById(str(args, "operation_id", true));
      if (spec.method !== "POST")
        throw new InvalidParams(
          `${spec.id} is not a POST action; use xos_read, xos_update or xos_delete.`,
        );
      requireWrite(ctx, spec);
      const key = str(args, "idempotency_key", false);
      const body = obj(args, "body");
      const response = await ctx.client.request(
        spec,
        { path: pathFor(spec, args), ...(body ? { body } : {}) },
        key ? { idempotencyKey: key } : undefined,
      );
      return { data: response.data ?? null, etag: response.etag };
    },
  },
  {
    write: true,
    definition: {
      name: "xos_delete",
      title: "Move a row to Trash",
      description:
        "Soft-deletes a row to Trash, where it can be restored for its retention period.",
      inputSchema: {
        type: "object",
        properties: {
          resource: RESOURCE_SCHEMA,
          id: { type: ["string", "number"] },
          path: PATH_SCHEMA,
        },
        required: ["resource"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: async (args, ctx) => {
      const spec = operation(str(args, "resource", true), "delete");
      requireWrite(ctx, spec);
      await ctx.client.request(spec, { path: pathFor(spec, args) });
      return { deleted: true };
    },
  },
];

function textResult(value: unknown, isError: boolean): ToolResult {
  const structured =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(structured ? { structuredContent: structured } : {}),
    isError,
  };
}

/** The tool set for a scope: write tools appear only when some write is in scope. */
export function createTools(ctx: ToolContext): ToolProvider {
  const writes = hasWrites(ctx.scope);
  const active = TOOLS.filter(
    (t) => !t.write || (writes && (t.definition.name !== "xos_delete" || ctx.scope.allowDelete)),
  );
  return {
    list: () => active.map((t) => t.definition),
    async call(name, args) {
      const tool = active.find((t) => t.definition.name === name);
      if (!tool) throw new InvalidParams(`Unknown tool: ${name}.`);
      try {
        return textResult(await tool.handler(args, ctx), false);
      } catch (error) {
        if (error instanceof XosApiError) {
          return textResult(
            {
              error: "api_error",
              status: error.status,
              operation: error.operationId,
              problem: error.problem,
            },
            true,
          );
        }
        if (error instanceof ScopeRefusal)
          return textResult({ error: "outside_write_scope", detail: error.message }, true);
        if (error instanceof XosNetworkError)
          return textResult({ error: "network_error", detail: error.message }, true);
        if (error instanceof TypeError && !(error instanceof InvalidParams)) {
          // The SDK refuses requests that cannot be sent, such as a missing required query parameter.
          throw new InvalidParams(error.message);
        }
        throw error;
      }
    },
  };
}
