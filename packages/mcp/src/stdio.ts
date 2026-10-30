/** The stdio transport of `xos-mcp`: newline-delimited JSON-RPC on stdin, one response line per request. */
import { createInterface } from "node:readline";
import type { McpSession } from "./protocol.ts";

/** Reads newline-delimited JSON-RPC messages and writes one response line per request. */
export function serveStdio(
  session: McpSession,
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    const task = session.handleText(line).then((response) => {
      if (response) write(`${JSON.stringify(response)}\n`);
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  return new Promise((resolve) => {
    lines.on("close", () => {
      void Promise.all(pending).then(() => resolve());
    });
  });
}
