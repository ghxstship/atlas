/**
 * Edits that a contract correction (`catalog/corrections.ts`, ADR 0023) applies to one frozen
 * resource. Each edit returns a new spec and never mutates the frozen definition, so the
 * uncorrected catalog stays available for the Section 18 gate 20 comparison.
 *
 * Shapes follow `defineResource` in `@xos/schemas`: a nullable field is optional on create, the
 * update body is the create body made partial, and component ids stay the same.
 */
import { z } from "@hono/zod-openapi";
import type { ResourceDefinition } from "@xos/schemas";
import type { CapabilityCode } from "@xos/schemas/capabilities/codes";
import type { CapabilityRule } from "./capabilities.ts";
import { RESOURCE_CAPABILITIES, canonRule } from "./capabilities.ts";
import type { ActionSpec, OrderSpec, ResourceSpec, Verb } from "./types.ts";

type Shape = Record<string, z.ZodType>;

/** Where an added field is accepted. */
export interface FieldPlacement {
  /** `required`, `optional` or absent (server-set) on create. Nullable fields are always optional. */
  readonly create?: "required" | "optional";
  /** Accepted on update. Defaults to true when the field is accepted on create. */
  readonly update?: boolean;
  /** False for a field the request carries but the read shape never returns (a write-only input). */
  readonly read?: false;
}

export interface AddedField extends FieldPlacement {
  readonly schema: z.ZodType;
  /**
   * The schema the create and update bodies accept, when it differs from the read shape: a
   * column that is nullable for old rows but that every new row must fill.
   */
  readonly writeSchema?: z.ZodType;
}

export interface ShapeEdit {
  /** Fields whose column is nullable: nullable in every shape, optional on create. */
  readonly nullable?: readonly string[];
  /** Fields the schema does not have, removed from every shape. */
  readonly remove?: readonly string[];
  /** Fields renamed to their column name, keeping their schema unless `add` replaces it. */
  readonly rename?: Readonly<Record<string, string>>;
  /** Fields added (or replaced in place, when the name exists) with their placement. */
  readonly add?: Readonly<Record<string, AddedField>>;
  /** Fields the server sets: removed from the create and update bodies, kept in the read shape. */
  readonly serverSet?: readonly string[];
  /** Fields made required on create (their column is NOT NULL without a default). */
  readonly requireOnCreate?: readonly string[];
  /** Fields made optional on create (the database supplies a default). */
  readonly optionalOnCreate?: readonly string[];
  /** Fields set on create and never changed: removed from the update body. */
  readonly immutable?: readonly string[];
  /** A new resource description, when the frozen one states something the schema does not do. */
  readonly description?: string;
  /**
   * The identifying field, when it changes. A renamed key follows its rename without this; set it
   * when the frozen key is removed. The path parameter and default order follow the key.
   */
  readonly key?: string;
}

function metaOf(schema: z.ZodType): Record<string, unknown> {
  return { ...(z.globalRegistry.get(schema) ?? {}) };
}

function unwrapOptional(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema;
}

function isNullOrNullable(schema: z.ZodType): boolean {
  const inner = unwrapOptional(schema);
  return (
    inner instanceof z.ZodNullable ||
    (inner instanceof z.ZodUnion && inner.options.some((o) => o instanceof z.ZodNull))
  );
}

/**
 * The nullable form of a field. A field that is a registered component becomes `anyOf` the
 * component and null: wrapping a component in `.nullable()` would let the generator emit the
 * shared component itself as nullable when this is the first place it meets it, changing every
 * other operation that references it.
 */
export function orNull(schema: z.ZodType): z.ZodType {
  const inner = unwrapOptional(schema);
  const registered = (s: z.ZodType) => z.globalRegistry.get(s)?.["id"] !== undefined;
  // A frozen `.nullable()` around a component is rewritten to the union form for the same reason.
  if (inner instanceof z.ZodNullable && registered(inner.unwrap() as z.ZodType)) {
    return z.union([inner.unwrap() as z.ZodType, z.null()]);
  }
  if (isNullOrNullable(inner)) return inner;
  return !registered(inner) ? inner.nullable() : z.union([inner, z.null()]);
}

function rebuild(object: z.ZodObject, shape: Shape, description?: string): z.ZodObject {
  const meta = metaOf(object);
  return z.object(shape).meta(description === undefined ? meta : { ...meta, description });
}

const BASE_FIELDS = new Set([
  "id",
  "org_id",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
]);

function assertFields(name: string, shape: Shape, fields: readonly string[], edit: string): void {
  for (const f of fields) {
    if (!(f in shape))
      throw new Error(`Correction ${edit} names ${name}.${f}, which is not a field.`);
  }
}

function without(shape: Shape, fields: readonly string[]): Shape {
  return Object.fromEntries(Object.entries(shape).filter(([k]) => !fields.includes(k)));
}

function notOnCreate(def: ResourceDefinition, f: string, edit: string): Error {
  return new Error(`Correction ${edit} names ${def.name}.${f}, which is not accepted on create.`);
}

/** Applies a shape edit to the read, create and update shapes of a definition. */
export function editDefinition(def: ResourceDefinition, edit: ShapeEdit): ResourceDefinition {
  const nullable = edit.nullable ?? [];
  const remove = edit.remove ?? [];
  const rename = edit.rename ?? {};
  assertFields(def.name, def.read.shape as Shape, remove, "remove");
  assertFields(def.name, def.read.shape as Shape, Object.keys(rename), "rename");

  const start = (object: z.ZodObject | undefined): Shape | undefined =>
    object === undefined
      ? undefined
      : without(
          Object.fromEntries(
            Object.entries(object.shape as Shape).map(([k, s]) => [rename[k] ?? k, s]),
          ),
          remove,
        );
  let r = start(def.read) as Shape;
  let c = start(def.create);
  let u = start(def.update);

  // Nullable names fields after renames: a renamed field takes its column name.
  assertFields(def.name, r, nullable, "nullable");
  for (const f of nullable) {
    r = { ...r, [f]: orNull(r[f] as z.ZodType) };
    if (c !== undefined && f in c) c = { ...c, [f]: orNull(c[f] as z.ZodType).optional() };
    if (u !== undefined && f in u) u = { ...u, [f]: orNull(u[f] as z.ZodType).optional() };
  }
  for (const [f, added] of Object.entries(edit.add ?? {})) {
    if (added.read !== false) r = { ...r, [f]: added.schema };
    const write = added.writeSchema ?? added.schema;
    if (added.create !== undefined) {
      if (c === undefined) {
        throw new Error(`${def.name} is read-only; ${f} cannot be accepted on create.`);
      }
      const optional = added.create === "optional" || isNullOrNullable(write);
      c = { ...c, [f]: optional ? write.optional() : write };
    } else if (c !== undefined) {
      c = without(c, [f]);
    }
    if (added.update ?? added.create !== undefined) {
      u = { ...(u ?? {}), [f]: write.optional() };
    } else if (u !== undefined) {
      u = without(u, [f]);
    }
  }
  const serverSet = edit.serverSet ?? [];
  assertFields(def.name, r, serverSet, "serverSet");
  if (c !== undefined) c = without(c, serverSet);
  if (u !== undefined) u = without(u, serverSet);
  for (const f of edit.requireOnCreate ?? []) {
    if (c === undefined || !(f in c)) throw notOnCreate(def, f, "requireOnCreate");
    c = { ...c, [f]: unwrapOptional(c[f] as z.ZodType) };
  }
  for (const f of edit.optionalOnCreate ?? []) {
    if (c === undefined || !(f in c)) throw notOnCreate(def, f, "optionalOnCreate");
    c = { ...c, [f]: unwrapOptional(c[f] as z.ZodType).optional() };
  }
  if (u !== undefined) u = without(u, edit.immutable ?? []);

  const updateMeta =
    def.update === undefined
      ? {
          id: `${def.name}Update`,
          description: `Fields accepted when updating a ${def.name}. Omitted fields are unchanged.`,
        }
      : metaOf(def.update);
  const key = edit.key ?? rename[def.key] ?? def.key;
  if (def.key !== "" && !(key in r)) {
    throw new Error(`Correction leaves ${def.name} without its key ${key}; set \`key\`.`);
  }
  return {
    ...def,
    key,
    keySchema: key === def.key ? def.keySchema : (r[key] as z.ZodType),
    description: edit.description ?? def.description,
    read: rebuild(def.read, r, edit.description),
    create: def.create === undefined || c === undefined ? undefined : rebuild(def.create, c),
    update:
      u === undefined || Object.keys(u).length === 0 ? undefined : z.object(u).meta(updateMeta),
    fields: Object.fromEntries(Object.entries(r).filter(([k]) => !BASE_FIELDS.has(k))),
  };
}

/** Edits the definition of a resource. */
export function editShape(edit: ShapeEdit) {
  return (spec: ResourceSpec): ResourceSpec => {
    const def = editDefinition(spec.def, edit);
    const fields = Object.keys(def.read.shape as Shape);
    const by = spec.order.by.map((f) => edit.rename?.[f] ?? f).filter((f) => fields.includes(f));
    const keyMoved = def.key !== spec.def.key;
    return {
      ...spec,
      def,
      keyParam: keyMoved && spec.keyParam === spec.def.key ? def.key : spec.keyParam,
      order:
        by.length === spec.order.by.length
          ? {
              ...spec.order,
              by,
              ...(spec.order.examples === undefined
                ? {}
                : {
                    examples: spec.order.examples.map((row) =>
                      Object.fromEntries(
                        Object.entries(row)
                          .map(([k, v]) => [edit.rename?.[k] ?? k, v] as const)
                          .filter(([k]) => fields.includes(k)),
                      ),
                    ),
                  }),
            }
          : { by: [def.key === "" ? (fields[0] as string) : def.key], numeric: false },
    };
  };
}

/** Removes standard verbs the schema cannot serve. */
export function removeVerbs(...verbs: readonly Verb[]) {
  return (spec: ResourceSpec): ResourceSpec => {
    for (const v of verbs) {
      if (!spec.verbs.includes(v)) throw new Error(`${spec.op} has no ${v} to remove.`);
    }
    return { ...spec, verbs: spec.verbs.filter((v) => !verbs.includes(v)) };
  };
}

/** Removes actions the schema cannot serve. */
export function removeActions(...verbs: readonly string[]) {
  return (spec: ResourceSpec): ResourceSpec => {
    for (const v of verbs) {
      if (!spec.actions.some((a) => a.verb === v))
        throw new Error(`${spec.op} has no ${v} action to remove.`);
    }
    return { ...spec, actions: spec.actions.filter((a) => !verbs.includes(a.verb)) };
  };
}

/** Replaces actions by verb, or adds them, with optional capabilities for the new verbs. */
export function putActions(
  actions: readonly ActionSpec[],
  capabilities: Readonly<Record<string, CapabilityCode>> = {},
) {
  return (spec: ResourceSpec): ResourceSpec => {
    const byVerb = new Map(actions.map((a) => [a.verb, a]));
    const kept = spec.actions.map((a) => byVerb.get(a.verb) ?? a);
    const added = actions.filter((a) => !spec.actions.some((x) => x.verb === a.verb));
    const next: ResourceSpec = { ...spec, actions: [...kept, ...added] };
    if (Object.keys(capabilities).length === 0) return next;
    const current: CapabilityRule =
      spec.capabilityRule ?? RESOURCE_CAPABILITIES[spec.op] ?? canonRule(spec.op) ?? {};
    return {
      ...next,
      capabilityRule: { ...current, actions: { ...current.actions, ...capabilities } },
    };
  };
}

/** Points the resource at the table or view that actually serves it (`x-xos-table`). */
export function setTable(table: string) {
  return (spec: ResourceSpec): ResourceSpec => ({ ...spec, def: { ...spec.def, table } });
}

/** Changes the capability rule: the fields given replace the rule's, and `actions` merge. */
export function setCapabilities(rule: CapabilityRule) {
  return (spec: ResourceSpec): ResourceSpec => {
    const current: CapabilityRule =
      spec.capabilityRule ?? RESOURCE_CAPABILITIES[spec.op] ?? canonRule(spec.op) ?? {};
    return {
      ...spec,
      capabilityRule: { ...current, ...rule, actions: { ...current.actions, ...rule.actions } },
    };
  };
}

/** Sets the default list order. */
export function setOrder(order: OrderSpec) {
  return (spec: ResourceSpec): ResourceSpec => ({ ...spec, order });
}

/** Composes edits left to right. */
export function all(...edits: readonly ((spec: ResourceSpec) => ResourceSpec)[]) {
  return (spec: ResourceSpec): ResourceSpec => edits.reduce((s, e) => e(s), spec);
}
