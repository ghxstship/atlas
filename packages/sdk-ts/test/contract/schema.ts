/**
 * A JSON Schema validator and example builder for the subset of JSON Schema 2020-12 that the
 * XOS OpenAPI document uses: type (including type arrays), enum, properties, required,
 * additionalProperties, items, allOf, anyOf, oneOf, $ref to components, string length,
 * pattern, numeric range and the uuid, date, date-time, email and uri formats.
 */

export type Schema = {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | Schema;
  readonly items?: Schema;
  readonly allOf?: readonly Schema[];
  readonly anyOf?: readonly Schema[];
  readonly oneOf?: readonly Schema[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly example?: unknown;
  readonly [keyword: string]: unknown;
};

export interface SchemaError {
  readonly pointer: string;
  readonly detail: string;
}

const FORMATS: Readonly<Record<string, RegExp>> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  uri: /^[a-z][a-z0-9+.-]*:/i,
};

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

function escape(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export class SchemaSet {
  readonly #components: Readonly<Record<string, Schema>>;
  readonly #patterns = new Map<string, RegExp>();

  constructor(components: Readonly<Record<string, Schema>>) {
    this.#components = components;
  }

  resolve(schema: Schema): Schema {
    let current = schema;
    for (let depth = 0; current.$ref; depth++) {
      if (depth > 32) throw new Error(`Reference cycle at ${schema.$ref}`);
      const name = current.$ref.replace("#/components/schemas/", "");
      const next = this.#components[name];
      if (!next) throw new Error(`Unknown schema ${current.$ref}`);
      current = next;
    }
    return current;
  }

  component(name: string): Schema {
    const s = this.#components[name];
    if (!s) throw new Error(`Unknown schema ${name}`);
    return s;
  }

  #pattern(source: string): RegExp {
    let re = this.#patterns.get(source);
    if (!re) {
      re = new RegExp(source, "u");
      this.#patterns.set(source, re);
    }
    return re;
  }

  validate(schema: Schema, value: unknown, pointer = ""): SchemaError[] {
    const s = this.resolve(schema);
    const errors: SchemaError[] = [];
    const fail = (detail: string) => errors.push({ pointer, detail });

    if (s.allOf) {
      // `allOf: [$ref, { type: [T, "null"] }]` marks a nullable reference in this contract.
      const nullable = s.allOf.some((m) => Array.isArray(m.type) && m.type.includes("null"));
      if (!(nullable && value === null)) {
        for (const member of s.allOf) {
          const t = member.type;
          if (nullable && Array.isArray(t) && t.includes("null")) continue;
          errors.push(...this.validate(member, value, pointer));
        }
      }
    }
    const union = s.anyOf ?? s.oneOf;
    if (union && !union.some((m) => this.validate(m, value, pointer).length === 0)) {
      fail("matches none of the allowed shapes");
    }
    if (s.enum && !s.enum.some((e) => e === value))
      fail(`must be one of ${JSON.stringify(s.enum)}`);
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type as string];
      if (!types.some((t) => matchesType(value, t))) {
        fail(`must be ${types.join(" or ")}, got ${typeOf(value)}`);
        return errors;
      }
    }
    if (typeof value === "string") {
      if (s.minLength !== undefined && [...value].length < s.minLength)
        fail(`must be at least ${s.minLength} characters`);
      if (s.maxLength !== undefined && [...value].length > s.maxLength)
        fail(`must be at most ${s.maxLength} characters`);
      if (s.pattern && !this.#pattern(s.pattern).test(value)) fail(`must match ${s.pattern}`);
      const format = s.format ? FORMATS[s.format] : undefined;
      if (format && !format.test(value)) fail(`must be a ${s.format}`);
    }
    if (typeof value === "number") {
      if (s.minimum !== undefined && value < s.minimum) fail(`must be at least ${s.minimum}`);
      if (s.maximum !== undefined && value > s.maximum) fail(`must be at most ${s.maximum}`);
      if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum)
        fail(`must be greater than ${s.exclusiveMinimum}`);
    }
    if (Array.isArray(value) && s.items) {
      value.forEach((item, i) =>
        errors.push(...this.validate(s.items as Schema, item, `${pointer}/${i}`)),
      );
    }
    if (
      typeOf(value) === "object" &&
      (s.properties || s.required || s.additionalProperties !== undefined)
    ) {
      const obj = value as Record<string, unknown>;
      for (const name of s.required ?? []) {
        if (!(name in obj))
          errors.push({ pointer: `${pointer}/${escape(name)}`, detail: "is required" });
      }
      for (const [name, member] of Object.entries(obj)) {
        const prop = s.properties?.[name];
        const child = `${pointer}/${escape(name)}`;
        if (prop) errors.push(...this.validate(prop, member, child));
        else if (s.additionalProperties === false)
          errors.push({ pointer: child, detail: "is not allowed" });
        else if (typeof s.additionalProperties === "object") {
          errors.push(...this.validate(s.additionalProperties, member, child));
        }
      }
    }
    return errors;
  }

  /**
   * A value that satisfies the schema, built from the document's own examples. With
   * `requiredOnly`, optional object members are left out.
   */
  example(schema: Schema, requiredOnly = false, depth = 0): unknown {
    if (depth > 12) return null;
    if (schema.$ref) return this.example(this.resolve(schema), requiredOnly, depth + 1);
    // Object examples are rebuilt member by member so `requiredOnly` holds.
    if (
      schema.example !== undefined &&
      typeOf(schema.example) !== "object" &&
      this.validate(schema, schema.example).length === 0
    ) {
      return schema.example;
    }
    if (schema.allOf) {
      const concrete = schema.allOf.find(
        (m) => !(Array.isArray(m.type) && m.type.includes("null")),
      );
      return concrete ? this.example(concrete, requiredOnly, depth + 1) : null;
    }
    const union = schema.anyOf ?? schema.oneOf;
    if (union) {
      const first = union.find((m) => m.type !== "null") ?? union[0];
      return first ? this.example(first, requiredOnly, depth + 1) : null;
    }
    if (schema.enum) return schema.enum[0];
    const types =
      schema.type === undefined
        ? schema.properties
          ? ["object"]
          : []
        : Array.isArray(schema.type)
          ? schema.type
          : [schema.type];
    const type = types.find((t) => t !== "null") ?? types[0];
    switch (type) {
      case "object": {
        const out: Record<string, unknown> = {};
        const required = new Set(schema.required ?? []);
        for (const [name, prop] of Object.entries(schema.properties ?? {})) {
          if (requiredOnly && !required.has(name)) continue;
          out[name] = this.example(prop, requiredOnly, depth + 1);
        }
        return out;
      }
      case "array":
        return schema.items ? [this.example(schema.items, requiredOnly, depth + 1)] : [];
      case "string":
        return this.#stringExample(schema);
      case "integer":
        return Math.max(schema.minimum ?? 1, 1);
      case "number":
        return Math.max(schema.minimum ?? 1, (schema.exclusiveMinimum ?? 0) + 1);
      case "boolean":
        return true;
      case "null":
        return null;
      default:
        return null;
    }
  }

  #stringExample(schema: Schema): string {
    switch (schema.format) {
      case "uuid":
        return "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f";
      case "date":
        return "2026-10-08";
      case "date-time":
        return "2026-10-08T14:30:00Z";
      case "email":
        return "crew@example.com";
      case "uri":
        return "https://example.com/";
      default:
        return "x".repeat(Math.max(schema.minLength ?? 1, 1));
    }
  }
}
