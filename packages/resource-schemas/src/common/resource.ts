/**
 * `defineResource` turns one field list into the three shapes the contract needs:
 * the read shape, the create body and the update body. Field names are Section 7 columns.
 */
import { z } from "zod";
import { instant, ref, uuid } from "./fields.ts";
import { maskable } from "./envelope.ts";

export type Shape = Record<string, z.ZodType>;

/**
 * - `tenant`: an `app` table with `org_id` and the audit columns (ADR 0002).
 * - `global`: a platform table that is not owned by one tenant, such as `people`.
 * - `canon`: an `xpms` table keyed by its natural code; read-only.
 * - `view`: a derived view or report row; read-only and keyless.
 */
export type ResourceBase = "tenant" | "global" | "canon" | "view";

export interface ResourceInput {
  /** PascalCase singular name; becomes the component schema id. */
  readonly name: string;
  /** Source table or view, schema-qualified. */
  readonly table: string;
  /** Sentence-case description, period-terminated. */
  readonly description: string;
  readonly fields: Shape;
  readonly base?: ResourceBase;
  /** Natural key for canon resources, for example `dept_code`. */
  readonly key?: string;
  /** Fields only the server sets: lifecycle states, derived values, totals. */
  readonly serverSet?: readonly string[];
  /** Fields set on create and never changed, such as the parent reference. */
  readonly immutable?: readonly string[];
  /** Restricted fields (Section 8.3), masked in the read shape for callers without the capability. */
  readonly restricted?: readonly string[];
}

export interface ResourceDefinition {
  readonly name: string;
  readonly table: string;
  readonly description: string;
  readonly base: ResourceBase;
  /** Name of the identifying field (`id` or the natural code). */
  readonly key: string;
  readonly keySchema: z.ZodType;
  readonly read: z.ZodObject;
  readonly create: z.ZodObject | undefined;
  readonly update: z.ZodObject | undefined;
  readonly fields: Shape;
  readonly restricted: readonly string[];
}

function labelOf(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function baseFields(base: ResourceBase, name: string): Shape {
  switch (base) {
    case "tenant":
      return {
        id: uuid(`Identifier of the ${name}.`),
        org_id: ref(
          "owning organization, derived from the parent row and never accepted from the caller",
        ),
        created_at: instant("When the row was created."),
        created_by: ref("person who created the row"),
        updated_at: instant("When the row was last updated."),
        updated_by: ref("person who last updated the row"),
      };
    case "global":
      return {
        id: uuid(`Identifier of the ${name}.`),
        created_at: instant("When the row was created."),
        updated_at: instant("When the row was last updated."),
      };
    case "canon":
    case "view":
      return {};
  }
}

function pick(shape: Shape, exclude: ReadonlySet<string>): Shape {
  return Object.fromEntries(Object.entries(shape).filter(([k]) => !exclude.has(k)));
}

function assertKnown(name: string, shape: Shape, keys: readonly string[], label: string): void {
  for (const k of keys) {
    if (!(k in shape)) throw new Error(`${name}: ${label} field "${k}" is not declared.`);
  }
}

export function defineResource(input: ResourceInput): ResourceDefinition {
  const base = input.base ?? "tenant";
  const serverSet = input.serverSet ?? [];
  const immutable = input.immutable ?? [];
  const restricted = input.restricted ?? [];
  assertKnown(input.name, input.fields, serverSet, "serverSet");
  assertKnown(input.name, input.fields, immutable, "immutable");
  assertKnown(input.name, input.fields, restricted, "restricted");

  const key = input.key ?? (base === "canon" || base === "view" ? "" : "id");
  const all: Shape = { ...baseFields(base, labelOf(input.name)), ...input.fields };
  if (key !== "" && !(key in all)) throw new Error(`${input.name}: key "${key}" is not declared.`);

  const readShape: Shape = Object.fromEntries(
    Object.entries(all).map(([k, s]) => [k, restricted.includes(k) ? maskable(s) : s]),
  );
  const read = z.object(readShape).meta({ id: input.name, description: input.description });

  const writable = base === "tenant" || base === "global";
  // A nullable column is optional on create: omitting it stores NULL (for money, unpriced).
  const createShape = Object.fromEntries(
    Object.entries(pick(input.fields, new Set(serverSet))).map(([k, s]) => [
      k,
      s instanceof z.ZodNullable ? s.optional() : s,
    ]),
  );
  const create = writable
    ? z.object(createShape).meta({
        id: `${input.name}Create`,
        description: `Fields accepted when creating a ${input.name}.`,
      })
    : undefined;
  const updateShape = pick(createShape, new Set(immutable));
  const update =
    writable && Object.keys(updateShape).length > 0
      ? z
          .object(updateShape)
          .partial()
          .meta({
            id: `${input.name}Update`,
            description: `Fields accepted when updating a ${input.name}. Omitted fields are unchanged.`,
          })
      : undefined;

  return {
    name: input.name,
    table: input.table,
    description: input.description,
    base,
    key,
    keySchema: key === "" ? z.never() : (all[key] as z.ZodType),
    read,
    create,
    update,
    fields: input.fields,
    restricted,
  };
}
