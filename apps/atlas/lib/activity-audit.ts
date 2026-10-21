/**
 * An audit ledger action in words (Section 11.10 item 2, A59-017): `goods_receipts.update` on
 * `app.goods_receipts` reads "Updated a goods receipt", with the code beside it, never alone. The noun
 * comes from activity.subjects by the table's singular name; a table without one reads as its name in
 * words. `t` reads the `activity` namespace.
 */
export function singularTable(subjectTable: string): string {
  const table = subjectTable.replace(/^[a-z_]+\./, "");
  if (table.endsWith("ies")) return `${table.slice(0, -3)}y`;
  if (/(ss|x|ch|sh)es$/.test(table)) return table.slice(0, -2);
  if (table.endsWith("s") && !table.endsWith("ss")) return table.slice(0, -1);
  return table;
}

export function auditActionText(
  action: string,
  subjectTable: string,
  t: ((key: string, values?: Record<string, string>) => string) & {
    has: (key: string) => boolean;
  },
): string {
  const op = action.slice(action.lastIndexOf(".") + 1);
  const verb = ["insert", "update", "delete"].includes(op)
    ? t(`audit.ops.${op}`)
    : t("audit.ops.other");
  const singular = singularTable(subjectTable);
  const subject = t.has(`subjects.${singular}`)
    ? t(`subjects.${singular}`)
    : singular.replaceAll("_", " ");
  return t("audit.actionText", { op: verb, subject });
}
