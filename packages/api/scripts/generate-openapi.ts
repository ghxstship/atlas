/**
 * Writes the generated OpenAPI 3.1 document to `packages/api/openapi/v1.json`.
 * Run with `pnpm --filter @xos/api generate`. The contract tests fail when the committed file
 * differs from a fresh generation, so CI catches hand edits and forgotten regenerations.
 */
import { writeFileSync } from "node:fs";
import { DOCUMENT_FILE, renderOpenApiDocument } from "../src/document.ts";

writeFileSync(DOCUMENT_FILE, await renderOpenApiDocument());
console.log(`Wrote ${DOCUMENT_FILE}`);
