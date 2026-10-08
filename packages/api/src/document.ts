/**
 * Deterministic serialization of the OpenAPI document: the same catalog always yields the same
 * bytes, formatted with the repository Prettier config so `format:check` accepts the file.
 */
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { buildOpenApiDocument } from "./app.ts";

export const DOCUMENT_PATH = "openapi/v1.json";
export const DOCUMENT_FILE = fileURLToPath(new URL(`../${DOCUMENT_PATH}`, import.meta.url));

export async function renderOpenApiDocument(): Promise<string> {
  const json = JSON.stringify(buildOpenApiDocument());
  const config = (await resolveConfig(DOCUMENT_FILE)) ?? {};
  return format(json, { ...config, parser: "json" });
}
