/**
 * An audit ledger action in words (Section 11.10 item 2, A59-017): `goods_receipts.update` on
 * `app.goods_receipts` reads "Updated a goods receipt", with the code beside it, never alone. The noun
 * comes from activity.subjects by the table's singular name; a table without one reads as its name in
 * words. `t` reads the `activity` namespace.
 */
export function singularTable(subjectTable: string): string {
  const table = bareTable(subjectTable);
  if (table.endsWith("ies")) return `${table.slice(0, -3)}y`;
  if (/(ss|x|ch|sh)es$/.test(table)) return table.slice(0, -2);
  if (table.endsWith("s") && !table.endsWith("ss")) return table.slice(0, -1);
  return table;
}

type ActivityT = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

/** A table without its schema: `app.projects` reads `projects`. */
function bareTable(subjectTable: string): string {
  return subjectTable.replace(/^[a-z_]+\./, "");
}

/**
 * A table's name in words for a label that has no catalog noun (Trash's Kind, the legal-hold table picker):
 * `app.onboarding_requirements` reads "Onboarding requirements", never the identifier itself.
 */
export function tableWords(subjectTable: string): string {
  const words = bareTable(subjectTable).replaceAll("_", " ").trim();
  return words.length === 0 ? subjectTable : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** Tables only the platform support team writes during a support session the Owner granted (A90, 1472). */
const SUPPORT_TABLES = new Set(["support_sessions", "support_session_accesses"]);
const SUPPORT_AREAS = new Set(["Overview", "Members", "Projects", "Settings"]);

/** The area a platform support read opened, from the audit copy of its app.support_session_accesses row. */
function supportArea(subjectTable: string, diff: Readonly<Record<string, unknown>>): string | null {
  if (bareTable(subjectTable) !== "support_session_accesses") return null;
  const row = diff["new"];
  const area =
    row !== null && typeof row === "object" ? (row as Record<string, unknown>)["area"] : null;
  return typeof area === "string" && SUPPORT_AREAS.has(area) ? area : null;
}

/**
 * Who made an audit entry, in words. A platform support operator is not a member, so row level security hides their
 * name from the org: their reads are the platform team's, never "A person" or "Redacted" (crawl 4.9). `t` reads the
 * `activity` namespace.
 */
export function auditActorText(
  entry: {
    readonly actor: string | null;
    readonly actorKind: string;
    readonly subjectTable: string;
    readonly redacted: boolean;
  },
  t: ActivityT,
): string {
  if (entry.actor) return entry.actor;
  if (SUPPORT_TABLES.has(bareTable(entry.subjectTable))) return t("audit.platformTeam");
  if (entry.actorKind === "Service") return t("audit.service");
  if (entry.actorKind === "Person") return entry.redacted ? t("audit.redacted") : t("audit.person");
  return t("audit.systemActor");
}

/**
 * What an audit entry changed, in words: the area a platform support read opened ("Opened Members"), as the Security
 * panel's access log says it, or the fields of any other change. Empty when there is nothing to add.
 */
export function auditDetailText(
  entry: {
    readonly subjectTable: string;
    readonly diff: Readonly<Record<string, unknown>>;
    readonly redacted: boolean;
  },
  t: ActivityT,
): string {
  if (entry.redacted) return t("audit.redacted");
  const area = supportArea(entry.subjectTable, entry.diff);
  if (area !== null) return t("audit.supportOpened", { area: t(`audit.areas.${area}`) });
  const fields = Object.keys(entry.diff);
  return fields.length > 0
    ? t("audit.changedFieldList", { count: fields.length, fields: fields.join(", ") })
    : "";
}

export function auditActionText(action: string, subjectTable: string, t: ActivityT): string {
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
