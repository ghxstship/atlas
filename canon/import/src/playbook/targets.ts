/**
 * Where a Playbook `field` target can be found (Section 18 gate 14): the columns of the generated database types and
 * the row fields the OpenAPI document returns for each table.
 */

/** Every `schema.relation.column` of a table or view Row in the generated database types. */
export function schemaColumns(types: string): Set<string> {
  const columns = new Set<string>();
  let schema = "";
  let section = "";
  let relation = "";
  let inRow = false;
  for (const line of types.split("\n")) {
    const schemaMatch = /^ {2}([a-z_]+): \{$/.exec(line);
    if (schemaMatch) {
      schema = schemaMatch[1] as string;
      continue;
    }
    const sectionMatch = /^ {4}(Tables|Views|Functions|Enums|CompositeTypes): \{$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1] as string;
      continue;
    }
    if (section !== "Tables" && section !== "Views") continue;
    const relationMatch = /^ {6}([a-z0-9_]+): \{$/.exec(line);
    if (relationMatch) {
      relation = relationMatch[1] as string;
      continue;
    }
    if (/^ {8}Row: \{$/.test(line)) {
      inRow = true;
      continue;
    }
    if (inRow && /^ {8}\}/.test(line)) {
      inRow = false;
      continue;
    }
    const columnMatch = /^ {10}([a-z0-9_]+)\??:/.exec(line);
    if (inRow && columnMatch) columns.add(`${schema}.${relation}.${columnMatch[1] as string}`);
  }
  return columns;
}

/** The parts of an OpenAPI 3.1 document the exposure check reads. */
export interface OpenApiSchema {
  readonly $ref?: string;
  readonly properties?: Readonly<Record<string, OpenApiSchema>>;
  readonly items?: OpenApiSchema;
  readonly allOf?: readonly OpenApiSchema[];
  readonly oneOf?: readonly OpenApiSchema[];
  readonly anyOf?: readonly OpenApiSchema[];
}

interface OpenApiOperation {
  readonly "x-xos-table"?: string;
  readonly responses?: Readonly<
    Record<
      string,
      { readonly content?: Readonly<Record<string, { readonly schema?: OpenApiSchema }>> }
    >
  >;
}

export interface OpenApiDocument {
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
  readonly components: { readonly schemas: Readonly<Record<string, OpenApiSchema>> };
}

/** Property names a response returns for each row, following $ref, compositions and a page's `data` array. */
function rowFields(
  doc: OpenApiDocument,
  schema: OpenApiSchema | undefined,
  seen: Set<string>,
): string[] {
  if (!schema) return [];
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop() as string;
    if (seen.has(name)) return [];
    seen.add(name);
    return rowFields(doc, doc.components.schemas[name], seen);
  }
  const out: string[] = [];
  for (const part of [...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) {
    out.push(...rowFields(doc, part, seen));
  }
  if (schema.properties) {
    out.push(...Object.keys(schema.properties));
    const data = schema.properties["data"];
    if (data) out.push(...rowFields(doc, data.items ?? data, seen));
  }
  if (schema.items) out.push(...rowFields(doc, schema.items, seen));
  return out;
}

/**
 * For each table or view an operation names in `x-xos-table`, the row fields its GET operations return. A table
 * that only appears on write operations maps to an empty set.
 */
export function exposedFields(doc: OpenApiDocument): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const item of Object.values(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      const table = op["x-xos-table"];
      if (!table) continue;
      const set = out.get(table) ?? new Set<string>();
      out.set(table, set);
      if (method !== "get") continue;
      const schema = op.responses?.["200"]?.content?.["application/json"]?.schema;
      for (const field of rowFields(doc, schema, new Set())) set.add(field);
    }
  }
  return out;
}
