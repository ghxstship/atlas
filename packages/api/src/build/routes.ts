/**
 * Turns catalog entries into `@hono/zod-openapi` route definitions. Every definition carries an
 * operationId `{resource}.{verb}`, a summary, a description, its module tag and examples.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { RouteConfig } from "@hono/zod-openapi";
import { exampleOf, page } from "@xos/schemas";
import type { ResourceDefinition } from "@xos/schemas";
import type { SharedParameters } from "../conventions/components.ts";
import { ProblemResponseNames, successHeaders } from "../conventions/components.ts";
import type { ProblemStatus } from "../conventions/components.ts";
import type { ActionSpec, ResourceSpec } from "../catalog/types.ts";
import { RESOURCE_CAPABILITIES, canonRule } from "../catalog/capabilities.ts";

const JSON_MEDIA_TYPE = "application/json";

function problemRefs(statuses: readonly ProblemStatus[]) {
  return Object.fromEntries(
    statuses.map((s) => [String(s), { $ref: `#/components/responses/${ProblemResponseNames[s]}` }]),
  );
}

function article(label: string): string {
  return /^[aeiou]/i.test(label) && !/^(one|use)/i.test(label) ? "an" : "a";
}

const pageCache = new Map<string, z.ZodType>();

function pageOf(schema: z.ZodType, id: string): z.ZodType {
  const cached = pageCache.get(id);
  if (cached !== undefined) return cached;
  const p = page(schema, id);
  pageCache.set(id, p);
  return p;
}

function listExample(spec: ResourceSpec, item: unknown): unknown {
  const base = item as Record<string, unknown>;
  const rows = spec.order.examples ?? [];
  const data = rows.length === 0 ? [base] : rows.map((overrides) => ({ ...base, ...overrides }));
  return { data, next_cursor: null };
}

function pathParams(path: string, spec: ResourceSpec): z.ZodObject | undefined {
  const names = [...path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1] as string);
  if (names.length === 0) return undefined;
  const shape: Record<string, z.ZodType> = {};
  for (const name of names) {
    shape[name] =
      name === spec.keyParam && spec.def.key !== ""
        ? spec.def.keySchema
        : z
            .string()
            .min(1)
            .meta({ description: `The \`${name}\` path segment.`, example: "sponsor_activation" });
  }
  return z.object(shape);
}

function orderDescription(spec: ResourceSpec): string {
  const by = spec.order.by.map((f) => `\`${f}\``).join(", then ");
  return spec.order.numeric
    ? `Coded list: the default order is numeric code order by ${by}.`
    : `The default order is ${by} ascending.`;
}

function orderExtension(spec: ResourceSpec) {
  return { "x-xos-order": { by: [...spec.order.by], numeric: spec.order.numeric } };
}

interface Built {
  readonly route: RouteConfig;
}

/** The capability an operation requires (see `catalog/capabilities.ts`). */
export function capabilityFor(spec: ResourceSpec, verb: string, method: string): string {
  const rule = RESOURCE_CAPABILITIES[spec.op] ?? canonRule(spec.op);
  const pick = (): string | undefined => {
    if (rule === undefined) return undefined;
    const action = rule.actions?.[verb];
    if (action !== undefined) return action;
    switch (verb) {
      case "list":
      case "get":
        return rule.read;
      case "create":
        return rule.create ?? rule.write;
      case "delete":
        return rule.delete ?? rule.write;
      default:
        return method === "get" ? rule.read : rule.write;
    }
  };
  const capability = pick();
  if (capability === undefined) throw new Error(`No capability for ${spec.op}.${verb}.`);
  return capability;
}

/** OAuth scopes map one to one to capability groups: the capability's first segment. */
export function scopeOf(capability: string): string {
  return capability.split(".")[0] as string;
}

function base(spec: ResourceSpec, verb: string, method: string) {
  const capability = capabilityFor(spec, verb, method);
  return {
    operationId: `${spec.op}.${verb}`,
    tags: [spec.module],
    "x-xos-table": spec.def.table,
    "x-xos-capability": capability,
    security: [{ bearerJwt: [] }, { apiKey: [] }, { oauth2: [scopeOf(capability)] }],
  };
}

function readResponse(spec: ResourceSpec, description: string, status = 200) {
  return {
    [String(status)]: {
      description,
      headers: successHeaders(spec.def.key !== ""),
      content: { [JSON_MEDIA_TYPE]: { schema: spec.def.read, example: exampleOf(spec.def.read) } },
    },
  };
}

function standardRoutes(spec: ResourceSpec, params: SharedParameters): Built[] {
  const def: ResourceDefinition = spec.def;
  const label = spec.label;
  const a = article(label);
  const itemPath = `${spec.path}/{${spec.keyParam}}`;
  const routes: Built[] = [];
  const read = exampleOf(def.read);

  for (const verb of spec.verbs) {
    switch (verb) {
      case "list": {
        const p = pageOf(def.read, `${def.name}Page`);
        routes.push({
          route: createRoute({
            ...base(spec, "list", "get"),
            ...orderExtension(spec),
            method: "get",
            path: spec.path,
            summary: `List ${label} rows`,
            description: `${def.description} Returns a cursor page of ${label} rows the caller may see. ${orderDescription(spec)} Supports sparse fieldsets and the filter grammar.`,
            request: {
              ...(pathParams(spec.path, spec) ? { params: pathParams(spec.path, spec) } : {}),
              query: z.object({
                limit: params.limit,
                cursor: params.cursor,
                fields: params.fields,
                sort: params.sort,
                filter: params.filter,
              }),
            },
            responses: {
              200: {
                description: `A page of ${label} rows.`,
                headers: successHeaders(false),
                content: { [JSON_MEDIA_TYPE]: { schema: p, example: listExample(spec, read) } },
              },
              ...problemRefs([400, 401, 429]),
            },
          }),
        });
        break;
      }
      case "get":
        routes.push({
          route: createRoute({
            ...base(spec, "get", "get"),
            method: "get",
            path: itemPath,
            summary: `Get ${a} ${label}`,
            description: `${def.description} Returns one ${label} with its \`ETag\`. A ${label} the caller may not see returns 404.`,
            request: {
              params: pathParams(itemPath, spec),
              query: z.object({ fields: params.fields }),
            },
            responses: {
              ...readResponse(spec, `The ${label}.`),
              ...problemRefs([400, 401, 404, 429]),
            },
          }),
        });
        break;
      case "create": {
        const body = def.create;
        if (body === undefined)
          throw new Error(`${def.name} is read-only and cannot declare create.`);
        routes.push({
          route: createRoute({
            ...base(spec, "create", "post"),
            method: "post",
            path: spec.path,
            summary: `Create ${a} ${label}`,
            description: `${def.description} Creates ${a} ${label}. Requires \`Idempotency-Key\`; a replay returns the original response. The organization is derived from the credential or the parent row, never from the body.`,
            request: {
              ...(pathParams(spec.path, spec) ? { params: pathParams(spec.path, spec) } : {}),
              headers: [params.idempotencyKey],
              body: {
                required: true,
                content: { [JSON_MEDIA_TYPE]: { schema: body, example: exampleOf(body) } },
              },
            },
            responses: {
              ...readResponse(spec, `The created ${label}.`, 201),
              ...problemRefs([400, 401, 409, 422, 429]),
            },
          }),
        });
        break;
      }
      case "update": {
        const body = def.update;
        if (body === undefined)
          throw new Error(`${def.name} has no updatable fields and cannot declare update.`);
        routes.push({
          route: createRoute({
            ...base(spec, "update", "patch"),
            method: "patch",
            path: itemPath,
            summary: `Update ${a} ${label}`,
            description: `${def.description} Updates the fields sent; omitted fields are unchanged. Requires \`If-Match\` with the current \`ETag\`: a stale tag returns 412 and a missing tag returns 428.`,
            request: {
              params: pathParams(itemPath, spec),
              headers: [params.ifMatch],
              body: {
                required: true,
                content: { [JSON_MEDIA_TYPE]: { schema: body, example: exampleOf(body) } },
              },
            },
            responses: {
              ...readResponse(spec, `The updated ${label}.`),
              ...problemRefs([400, 401, 404, 412, 422, 428, 429]),
            },
          }),
        });
        break;
      }
      case "delete":
        routes.push({
          route: createRoute({
            ...base(spec, "delete", "delete"),
            method: "delete",
            path: itemPath,
            summary: `Delete ${a} ${label}`,
            description: `${def.description} Soft-deletes the ${label}: it moves to Trash and can be restored for its table's retention period.`,
            request: { params: pathParams(itemPath, spec) },
            responses: {
              204: { description: `The ${label} moved to Trash.` },
              ...problemRefs([401, 404, 422, 429]),
            },
          }),
        });
        break;
    }
  }
  return routes;
}

function actionRoute(spec: ResourceSpec, action: ActionSpec, params: SharedParameters): Built {
  const prefix = action.scope === "item" ? `${spec.path}/{${spec.keyParam}}` : spec.path;
  const path = action.segment === "" ? prefix : `${prefix}/${action.segment}`;
  const responseSchema = action.response ?? spec.def.read;
  const schema = action.paged
    ? pageOf(
        responseSchema,
        `${(responseSchema.meta()?.id as string | undefined) ?? spec.def.name}Page`,
      )
    : responseSchema;
  const one = exampleOf(responseSchema);
  const example = action.paged ? { data: [one], next_cursor: null } : one;
  const status = action.status ?? 200;
  const isPost = action.method === "post";
  const pp = pathParams(path, spec);

  const headers = isPost ? [params.idempotencyKey] : undefined;
  const request = {
    ...(pp ? { params: pp } : {}),
    ...(action.query ? { query: action.query } : {}),
    ...(headers ? { headers } : {}),
    ...(action.body
      ? {
          body: {
            required: true,
            content: {
              [JSON_MEDIA_TYPE]: { schema: action.body, example: exampleOf(action.body) },
            },
          },
        }
      : {}),
  };
  const refusalNote = " A rule that refuses the request returns 422 with `refusal` and `reason`.";
  const postNote = isPost
    ? " Requires `Idempotency-Key`; a replay returns the original response."
    : "";
  const errors: ProblemStatus[] =
    action.scope === "item" ? [400, 401, 404, 422, 429] : [400, 401, 422, 429];
  if (isPost) errors.splice(errors.indexOf(422), 0, 409);

  return {
    route: createRoute({
      ...base(spec, action.verb, action.method),
      method: action.method,
      path,
      summary: action.summary,
      description: `${action.description}${postNote}${refusalNote}`,
      request,
      responses: {
        [String(status)]: {
          description: status === 202 ? "Accepted for processing." : "The result.",
          headers: successHeaders(
            !action.paged && action.response === undefined && spec.def.key !== "",
          ),
          content: { [JSON_MEDIA_TYPE]: { schema, example } },
        },
        ...problemRefs(errors),
      },
    }),
  };
}

export function buildRoutes(
  specs: readonly ResourceSpec[],
  params: SharedParameters,
): RouteConfig[] {
  return specs.flatMap((spec) => [
    ...standardRoutes(spec, params).map((b) => b.route),
    ...spec.actions.map((a) => actionRoute(spec, a, params).route),
  ]);
}
