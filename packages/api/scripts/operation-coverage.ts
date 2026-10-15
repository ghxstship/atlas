/**
 * Prints which documented operations have handlers, by module (Section 18, gate 5).
 * `pnpm --filter @xos/api coverage:operations`; `--json` prints the full list, including the
 * operationIds still missing a handler.
 */
import { formatCoverage, operationCoverage } from "../src/operation-coverage.ts";

const rows = operationCoverage();
console.log(process.argv.includes("--json") ? JSON.stringify(rows, null, 2) : formatCoverage(rows));
