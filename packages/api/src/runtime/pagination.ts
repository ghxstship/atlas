/**
 * Cursor pagination and sparse fieldsets (ADR 0003). Cursors are opaque base64url JSON holding
 * the sort-key values of the last row on the page; a list reads `limit + 1` rows to know whether
 * another page exists, so `next_cursor` is null exactly on the last page.
 */
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../conventions/components.ts";
import { badRequest } from "../problem.ts";

export type CursorValue = string | number | boolean | null;
export type Cursor = Readonly<Record<string, CursorValue>>;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Decodes a cursor and checks it carries exactly `keys`; a foreign or damaged cursor is a 400. */
export function decodeCursor(token: string, keys: readonly string[]): Cursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch (error) {
    throw badRequest(`The cursor is not valid for this list (${(error as Error).message}).`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("The cursor is not valid for this list.");
  }
  const record = value as Record<string, unknown>;
  const valid =
    Object.keys(record).length === keys.length &&
    keys.every(
      (k) =>
        k in record &&
        (record[k] === null || ["string", "number", "boolean"].includes(typeof record[k])),
    );
  if (!valid) throw badRequest("The cursor is not valid for this list.");
  return record as Cursor;
}

/** The page size for a validated `limit`: default 50, maximum 200. */
export function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_PAGE_SIZE);
}

export interface Page<T> {
  readonly data: T[];
  readonly next_cursor: string | null;
}

/**
 * Builds a page from `limit + 1` fetched rows. `cursorOf` returns the sort-key values of a row.
 */
export function toPage<T>(rows: readonly T[], size: number, cursorOf: (row: T) => Cursor): Page<T> {
  const data = rows.slice(0, size);
  const last = data[data.length - 1];
  return {
    data,
    next_cursor: rows.length > size && last !== undefined ? encodeCursor(cursorOf(last)) : null,
  };
}

/**
 * Columns to select for a sparse fieldset. `fields` is the validated `fields` parameter; the
 * key is always returned. Unknown field names are a 400 naming them.
 */
export function selectColumns(
  fields: string | undefined,
  allowed: readonly string[],
  key: string,
): string[] {
  if (fields === undefined) return [...allowed];
  const requested = [...new Set(fields.split(","))];
  const unknown = requested.filter((f) => !allowed.includes(f));
  if (unknown.length > 0) {
    throw badRequest(`Unknown field(s) in fields: ${unknown.join(", ")}.`);
  }
  return allowed.filter((f) => f === key || requested.includes(f));
}
