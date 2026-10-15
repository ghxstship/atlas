/**
 * Writes, in order:
 * 1. `src/handlers/index.generated.ts` and `src/catalog/modules/index.generated.ts`;
 * 2. `openapi/v1.json`, so additive operations declared in `src/catalog/modules` are included;
 * 3. `src/contract/operations.generated.ts` from that document.
 * Run with `pnpm --filter @xos/api generate:handlers`; `--check` exits non-zero when any file is
 * stale instead of writing it. The handler and contract tests run the same checks.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ADDITIONS_INDEX_FILE,
  HANDLER_INDEX_FILE,
  OPERATION_TYPES_FILE,
  renderAdditionsIndex,
  renderHandlerIndex,
  renderOperationTypes,
} from "../src/codegen/handlers.ts";

const check = process.argv.includes("--check");
let stale = 0;

function emit(file: string, content: string): void {
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (current === content) return;
  if (check) {
    stale += 1;
    console.error(`${file} is stale. Run pnpm --filter @xos/api generate:handlers.`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`Wrote ${file}`);
}

emit(HANDLER_INDEX_FILE, await renderHandlerIndex());
emit(ADDITIONS_INDEX_FILE, await renderAdditionsIndex());
// Imported after the indexes are written, so the document sees the current additions.
const { DOCUMENT_FILE, renderOpenApiDocument } = await import("../src/document.ts");
const document = await renderOpenApiDocument();
emit(DOCUMENT_FILE, document);
emit(OPERATION_TYPES_FILE, await renderOperationTypes(document));
if (stale > 0) process.exit(1);
