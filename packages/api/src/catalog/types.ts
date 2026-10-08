/**
 * The resource catalog: one entry per public API resource, from which every route definition
 * is generated. Handlers are not part of the catalog; they mount module by module.
 */
import type { z } from "@hono/zod-openapi";
import type { ResourceDefinition } from "@xos/schemas";

/** Tags: the Atlas modules of Section 4.2, plus Gateway (4.4), Identity (4.8) and Platform (4.6, 4.10). */
export const MODULES = [
  "Home",
  "Projects",
  "Activity",
  "Schedule",
  "Work",
  "Show",
  "Knowledge",
  "Places",
  "Logistics",
  "Advancing",
  "Hospitality",
  "Assets",
  "Opportunities",
  "People",
  "Crew",
  "Credentials",
  "Finance",
  "Procurement",
  "Vendors",
  "Safety",
  "Canon",
  "Reports",
  "Settings",
  "Gateway",
  "Identity",
  "Platform",
] as const;

export type Module = (typeof MODULES)[number];

export type Verb = "list" | "get" | "create" | "update" | "delete";

export interface ActionSpec {
  /** camelCase verb; the operationId is `{resource}.{verb}`. */
  readonly verb: string;
  /** Path segment after the item or collection path. */
  readonly segment: string;
  readonly scope: "item" | "collection";
  readonly method: "get" | "post";
  readonly summary: string;
  readonly description: string;
  readonly body?: z.ZodType;
  readonly query?: z.ZodObject;
  /** Response schema; defaults to the resource read shape. */
  readonly response?: z.ZodType;
  /** Status of the success response; defaults to 200. */
  readonly status?: 200 | 201 | 202;
  /** A `{ data: [...] }` page of the response schema instead of one value. */
  readonly paged?: boolean;
}

/** Default list order. `numeric` marks a coded list, which always sorts in numeric code order. */
export interface OrderSpec {
  readonly by: readonly string[];
  readonly numeric: boolean;
  /** Field overrides for each item of the list example, in the documented order. */
  readonly examples?: readonly Readonly<Record<string, string | number>>[];
}

export interface ResourceSpec {
  readonly module: Module;
  /** Collection path under /api/v1, kebab-case plural. */
  readonly path: string;
  /** camelCase plural resource name used in operationIds. */
  readonly op: string;
  /** Lowercase singular label used in summaries. */
  readonly label: string;
  readonly def: ResourceDefinition;
  readonly verbs: readonly Verb[];
  readonly actions: readonly ActionSpec[];
  readonly order: OrderSpec;
  /** Path parameter name for the item; defaults to the resource key. */
  readonly keyParam: string;
}
