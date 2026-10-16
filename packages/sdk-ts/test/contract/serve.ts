/**
 * Runs the contract test server as a child process for test suites in other languages.
 *
 *   node --experimental-strip-types test/contract/serve.ts [--seed-on-miss] [--inputs FILE]
 *
 * Prints one JSON line `{ "baseUrl", "apiKey" }` once listening, then serves until stdin
 * closes. On exit it prints a JSON line `{ "violations": [...] }` to stderr and exits 1 if any
 * response failed schema validation. `--inputs` writes valid inputs for every operation.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { inputFor } from "./inputs.ts";
import { startContractServer } from "./server.ts";

const { values } = parseArgs({
  options: {
    "seed-on-miss": { type: "boolean", default: false },
    inputs: { type: "string" },
  },
});

const server = await startContractServer({ seedOnMiss: values["seed-on-miss"] });
if (values.inputs) {
  const inputs = Object.fromEntries(server.operations.map((op) => [op.id, inputFor(op)]));
  writeFileSync(values.inputs, JSON.stringify(inputs));
}
process.stdout.write(`${JSON.stringify({ baseUrl: server.baseUrl, apiKey: server.apiKey })}\n`);

process.stdin.resume();
process.stdin.on("end", () => {
  void server.close().then(() => {
    process.stderr.write(`${JSON.stringify({ violations: server.violations })}\n`);
    process.exit(server.violations.length > 0 ? 1 : 0);
  });
});
