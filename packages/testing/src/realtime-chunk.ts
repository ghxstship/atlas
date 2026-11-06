import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { realtimeClientGzipBytes } from "./budgets.ts";
import { transferBytes } from "./bundle-budget.ts";

/**
 * The Realtime client chunk (ADR 0027, owner decision of 2026-11-06). A live page fetches it once the page is idle, so a
 * measure that stops at a quiet second saw it only sometimes. It does not count toward a page's 200 KB: it has its own
 * limit, measured from the build so the answer never depends on timing, and it must never be in a page's first load. It
 * is known by the Phoenix protocol's join event, which a chunk name cannot change.
 */
const MARKER = "phx_join";

export interface RealtimeChunk {
  /** The chunk's name under static/chunks. */
  readonly name: string;
  readonly transferBytes: number;
}

export function findRealtimeChunks(nextDir: string): RealtimeChunk[] {
  const dir = join(nextDir, "static", "chunks");
  const out: RealtimeChunk[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".js")) continue;
    const body = readFileSync(join(dir, name));
    if (body.includes(MARKER)) out.push({ name, transferBytes: transferBytes(body) });
  }
  return out;
}

export function realtimeWithinLimit(chunks: readonly RealtimeChunk[]): boolean {
  return chunks.reduce((sum, c) => sum + c.transferBytes, 0) <= realtimeClientGzipBytes;
}

/** The route's first-load files that are the Realtime client: there must be none. */
export function realtimeInFirstLoad(
  files: readonly string[],
  chunks: readonly RealtimeChunk[],
): string[] {
  const names = new Set(chunks.map((c) => c.name));
  return files.filter((f) => names.has(f.split("/").pop() ?? ""));
}
