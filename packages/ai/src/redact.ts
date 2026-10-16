/**
 * What reaches a model, and what reaches the log (Section 4.7 guardrails, Section 14.3).
 *
 * - `scrubRecord` runs on every record before it is put in a prompt: excluded tables (medical
 *   encounters) are dropped whole, Restricted columns are dropped, and masked values (`{ masked:
 *   true }` and `is_masked`) are dropped, so the model never learns a value exists.
 * - `redactText` runs on prompts and outputs before they are logged. The database repeats the same
 *   pass (`private.ai_redact`), so a caller that skipped it still cannot store personal data.
 */

/** One row of `app.ai_never_send`: a Restricted column, or a whole table when `column` is null. */
export interface NeverSendEntry {
  readonly table: string;
  readonly column: string | null;
}

export class NeverSendList {
  private readonly tables = new Set<string>();
  private readonly columns = new Map<string, Set<string>>();

  constructor(entries: readonly NeverSendEntry[]) {
    for (const entry of entries) {
      if (entry.column === null) {
        this.tables.add(entry.table);
      } else {
        const set = this.columns.get(entry.table) ?? new Set<string>();
        set.add(entry.column);
        this.columns.set(entry.table, set);
      }
    }
  }

  /** True when no part of the table may be sent. Masked views share their base table's rule. */
  excludesTable(table: string): boolean {
    return this.tables.has(table) || this.tables.has(baseTable(table));
  }

  excludesColumn(table: string, column: string): boolean {
    return (
      this.columns.get(table)?.has(column) === true ||
      this.columns.get(baseTable(table))?.has(column) === true
    );
  }

  get size(): number {
    return this.tables.size + [...this.columns.values()].reduce((n, s) => n + s.size, 0);
  }
}

/** `app.pay_rates_masked` reads the rules of `app.pay_rates`. */
function baseTable(table: string): string {
  return table.endsWith("_masked") ? table.slice(0, -"_masked".length) : table;
}

function isMaskedValue(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)["masked"] === true
  );
}

export type ScrubbedRecord = Readonly<Record<string, unknown>>;

/**
 * The record as it may appear in a prompt, or null when its table is excluded. Nested objects are
 * scrubbed for masked values too; nested Restricted columns of other tables never appear in API
 * responses unmasked, so the masked check covers them.
 */
export function scrubRecord(
  table: string,
  record: Readonly<Record<string, unknown>>,
  neverSend: NeverSendList,
): ScrubbedRecord | null {
  if (neverSend.excludesTable(table)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "is_masked") continue;
    if (neverSend.excludesColumn(table, key)) continue;
    if (isMaskedValue(value)) continue;
    out[key] = scrubNested(value);
  }
  return out;
}

function scrubNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => !isMaskedValue(v)).map(scrubNested);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === "is_masked" || isMaskedValue(inner)) continue;
      out[key] = scrubNested(inner);
    }
    return out;
  }
  return value;
}

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[government id]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[card number]"],
  [/(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, "[phone]"],
];

/** Replaces email addresses, Social Security numbers, card numbers and phone numbers with labels. */
export function redactText(text: string): string {
  let out = text;
  for (const [pattern, label] of PATTERNS) out = out.replace(pattern, label);
  return out;
}
