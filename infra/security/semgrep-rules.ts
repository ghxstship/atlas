// Fixture for the local Semgrep rules (infra/security/semgrep-rules.yml), checked with
// `semgrep --test` by infra/security/semgrep.sh. Each `ruleid:` line must be reported and each `ok:`
// line must not. The main scan skips this file (.semgrepignore).
declare const db: {
  from(t: string): { or(f: string): unknown; filter(c: string, o: string, v: string): unknown };
};
declare const pg: { query(text: string, values?: unknown[]): unknown };
declare function safeTerm(s: string): string;

export function search(filter: { query: string }, input: { search: string }, id: string) {
  // ruleid: xos-postgrest-search-term-unsanitized
  db.from("opportunities").or(`title.ilike.*${filter.query}*,description.ilike.*${filter.query}*`);

  const raw = input.search.trim();
  // ruleid: xos-postgrest-search-term-unsanitized
  db.from("elements").or(`item.ilike.%${raw}%`);

  const term = safeTerm(filter.query);
  // ok: xos-postgrest-search-term-unsanitized
  db.from("opportunities").or(`title.ilike.*${term}*`);

  const cleaned = input.search.trim().replace(/[%,()]/g, " ");
  // ok: xos-postgrest-search-term-unsanitized
  db.from("elements").or(`item.ilike.%${cleaned}%`);

  const now = new Date().toISOString();
  // ok: xos-postgrest-search-term-unsanitized
  db.from("memberships").or(`valid_to.is.null,valid_to.gt.${now}`);

  // ruleid: xos-pg-query-interpolated
  pg.query(`select * from xpms.elements where element_id = '${id}'`);

  // ruleid: xos-pg-query-interpolated
  pg.query("select * from xpms.elements where element_id = '" + id + "'");

  // ok: xos-pg-query-interpolated
  pg.query("select * from xpms.elements where element_id = $1", [id]);
}

declare function csvField(value: string): string;

export function exportCell(value: string, name: string) {
  // ruleid: xos-csv-quoting-outside-csv-field
  const quoted = /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  // ruleid: xos-csv-quoting-outside-csv-field
  const again = `"${name.replaceAll('"', '""')}"`;
  // ok: xos-csv-quoting-outside-csv-field
  const safe = csvField(value);
  // ok: xos-csv-quoting-outside-csv-field
  const escaped = value.replace(/'/g, "''");
  return [quoted, again, safe, escaped];
}

export function callerAddress(headers: Headers, clientAddress: (h: Headers) => string | null) {
  // ruleid: xos-forwarded-for-first-entry
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const forwarded = headers.get("x-forwarded-for");
  // ruleid: xos-forwarded-for-first-entry
  const alsoFirst = forwarded?.split(",")[0];
  // ok: xos-forwarded-for-first-entry
  const trusted = clientAddress(headers);
  // ok: xos-forwarded-for-first-entry
  const real = headers.get("x-real-ip");
  return [first, alsoFirst, trusted, real];
}
