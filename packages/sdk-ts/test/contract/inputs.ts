/** Builds valid inputs for any operation from the document's examples. */
import type { OperationIR } from "../../codegen/ir.ts";
import { loadDocument } from "../../codegen/index.ts";
import type { Schema } from "./schema.ts";
import { SchemaSet } from "./schema.ts";

const document = loadDocument();
export const schemas = new SchemaSet(document.components.schemas as Record<string, Schema>);

export interface OperationInput {
  readonly path: Record<string, string>;
  readonly query: Record<string, string | number>;
  readonly body: unknown;
}

export function inputFor(op: OperationIR): OperationInput {
  const path: Record<string, string> = {};
  for (const p of op.pathParams) path[p.name] = String(schemas.example(p.schema));
  const query: Record<string, string | number> = {};
  for (const p of op.queryParams) {
    if (p.required) query[p.name] = schemas.example(p.schema) as string | number;
  }
  const body = op.body ? schemas.example(schemas.component(op.body), true) : undefined;
  return { path, query, body };
}
