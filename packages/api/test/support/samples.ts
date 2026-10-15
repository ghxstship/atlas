/**
 * Sample values built from openapi/v1.json (A04P contract tests): `sample("Opportunity")` is an
 * instance of the component made from its documented examples, enums and formats, checked against
 * the component before it is returned, so seeded rows and request bodies always fit the contract.
 */
import { contractDocument, validateSchema } from "./contract.ts";

type Json = Record<string, unknown>;

function resolve(node: Json): Json {
  let current = node;
  while (typeof current["$ref"] === "string") {
    const [, , kind, name] = (current["$ref"] as string).split("/");
    current = contractDocument.components[kind as string]?.[name as string] as Json;
  }
  return current;
}

const FORMAT_VALUES: Record<string, string> = {
  uuid: "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f",
  "date-time": "2026-10-08T14:30:00Z",
  date: "2026-10-08",
  email: "crew@example.com",
  uri: "https://example.com/item",
};

function valueOf(node: unknown, depth = 0): unknown {
  if (node === undefined || node === true || depth > 12) return null;
  const schema = resolve(node as Json);
  if ("const" in schema) return schema["const"];
  if (schema["example"] !== undefined) return schema["example"];
  if (Array.isArray(schema["examples"]) && schema["examples"].length > 0) {
    return schema["examples"][0];
  }
  if (Array.isArray(schema["enum"])) return schema["enum"][0];
  const options = (schema["anyOf"] ?? schema["oneOf"]) as unknown[] | undefined;
  if (options !== undefined) {
    const concrete = options.find((o) => resolve(o as Json)["type"] !== "null") ?? options[0];
    return valueOf(concrete, depth + 1);
  }
  if (Array.isArray(schema["allOf"])) return valueOf(schema["allOf"][0], depth + 1);
  const type = Array.isArray(schema["type"])
    ? (schema["type"] as string[]).find((t) => t !== "null")
    : (schema["type"] as string | undefined);
  switch (type) {
    case "object": {
      const properties = (schema["properties"] ?? {}) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(properties).map(([k, v]) => [k, valueOf(v, depth + 1)]),
      );
    }
    case "array":
      return [];
    case "integer":
    case "number":
      return typeof schema["minimum"] === "number" ? schema["minimum"] : 1;
    case "boolean":
      return false;
    case "string": {
      const format = schema["format"];
      if (typeof format === "string" && FORMAT_VALUES[format] !== undefined) {
        return FORMAT_VALUES[format];
      }
      return "Sample";
    }
    default:
      return null;
  }
}

/** An instance of a contract component with `overrides` applied, valid against the component. */
export function sample(component: string, overrides: Json = {}): Json {
  const node = { $ref: `#/components/schemas/${component}` };
  const value = { ...(valueOf(node) as Json), ...overrides };
  const errors = validateSchema(node, value);
  if (errors.length > 0) throw new Error(`sample(${component}) is invalid: ${errors.join("; ")}`);
  return value;
}
