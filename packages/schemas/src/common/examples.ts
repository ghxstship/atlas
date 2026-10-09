/**
 * Builds a deterministic example value from a schema, using the `example` each field builder
 * attaches. A leaf without an example is a contract defect, so it throws.
 */
import { z } from "zod";

function metaExample(schema: z.ZodType): { found: boolean; value?: unknown } {
  const meta = z.globalRegistry.get(schema);
  if (meta !== undefined && "example" in meta) return { found: true, value: meta["example"] };
  return { found: false };
}

export function exampleOf(schema: z.ZodType, path = "$"): unknown {
  const own = metaExample(schema);
  if (own.found) return own.value;

  if (schema instanceof z.ZodObject) {
    return Object.fromEntries(
      Object.entries(schema.shape as Record<string, z.ZodType>).map(([k, s]) => [
        k,
        exampleOf(s, `${path}.${k}`),
      ]),
    );
  }
  if (
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodReadonly
  ) {
    return exampleOf(schema.unwrap() as z.ZodType, path);
  }
  if (schema instanceof z.ZodArray) return [exampleOf(schema.element as z.ZodType, `${path}[0]`)];
  if (schema instanceof z.ZodUnion) return exampleOf(schema.options[0] as z.ZodType, path);
  if (schema instanceof z.ZodEnum) return schema.options[0];
  if (schema instanceof z.ZodLiteral) return schema.value;
  if (schema instanceof z.ZodBoolean) return true;
  throw new Error(`No example for the schema at ${path}.`);
}
