#!/usr/bin/env node
/**
 * `xos-mcp [--write all|resource,Module,...] [--allow-delete]`
 *
 * Runs the MCP server on stdio. Credentials come from XOS_API_KEY and XOS_BASE_URL. Without
 * --write (or XOS_MCP_WRITE) the server exposes read tools only.
 */
import { parseArgs } from "node:util";
import { createSession, optionsFromEnv, serveStdio } from "./server.ts";

try {
  const { values } = parseArgs({
    options: { write: { type: "string" }, "allow-delete": { type: "boolean" } },
  });
  const session = createSession(
    optionsFromEnv(process.env, { write: values.write, allowDelete: values["allow-delete"] }),
  );
  await serveStdio(session, process.stdin, (line) => process.stdout.write(line));
} catch (error) {
  process.stderr.write(`xos-mcp: ${(error as Error).message}\n`);
  process.exitCode = 2;
}
