/**
 * ETag and If-Match (ADR 0003). A row with `updated_at` gets a weak tag that encodes that
 * timestamp, so an update handler turns `If-Match` back into the version it must compare-and-set
 * (`.eq("updated_at", version)`) in the same statement as the write. Rows without `updated_at`
 * (canon, views) get a tag hashed from the body.
 */
import { createHash } from "node:crypto";
import { preconditionFailed } from "../problem.ts";

const PREFIX = 'W/"';

/** The ETag of a row or response body. */
export function etagOf(body: unknown): string {
  const row = body as { updated_at?: unknown } | null;
  if (row !== null && typeof row === "object" && typeof row.updated_at === "string") {
    return `${PREFIX}${Buffer.from(row.updated_at, "utf8").toString("base64url")}"`;
  }
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("base64url");
  return `${PREFIX}h${digest.slice(0, 22)}"`;
}

/**
 * The `updated_at` version an `If-Match` header names, for a compare-and-set update. Returns
 * null for `*` (any version). A tag this API did not issue is stale by definition: 412.
 */
export function versionFromIfMatch(ifMatch: string): string | null {
  const value = ifMatch.trim();
  if (value === "*") return null;
  const match = /^(?:W\/)?"([A-Za-z0-9_-]+)"$/.exec(value);
  const token = match?.[1];
  if (token === undefined || token.startsWith("h")) throw preconditionFailed();
  const version = Buffer.from(token, "base64url").toString("utf8");
  if (Number.isNaN(Date.parse(version))) throw preconditionFailed();
  return version;
}

/** True when `ifMatch` names the current representation (`*` always matches). */
export function ifMatchMatches(ifMatch: string, current: unknown): boolean {
  const value = ifMatch.trim();
  if (value === "*") return true;
  const tags = value.split(",").map((t) => t.trim());
  const tag = etagOf(current);
  return tags.includes(tag) || tags.includes(tag.slice(2));
}

/** Throws 412 unless `ifMatch` names the current representation. */
export function assertIfMatch(ifMatch: string, current: unknown): void {
  if (!ifMatchMatches(ifMatch, current)) throw preconditionFailed();
}
