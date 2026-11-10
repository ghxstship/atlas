import type { BulkField } from "./types";

/**
 * The changes every one of these rows allows (Section 11.7): a field with a `rows` list applies only
 * to the rows it names, so the bar offers it only when the whole selection is listed. An empty
 * selection allows every field; the page's order is kept.
 */
export function allowedFields(fields: readonly BulkField[], ids: Iterable<string>): BulkField[] {
  const list = [...ids];
  return fields.filter((f) => {
    const rows = f.rows;
    if (!rows) return true;
    const allowed = new Set(rows);
    return list.every((id) => allowed.has(id));
  });
}
