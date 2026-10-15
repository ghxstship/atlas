/**
 * Query string parsing (ADR 0003). Plain parameters become strings; the filter grammar
 * `filter[field][op]=value` becomes `{ filter: { field: { op: value } } }`, which the route's
 * `Filter` schema then validates (unknown operators are a 422).
 */

const FILTER_KEY = /^filter\[([^\][]+)\]\[([^\][]+)\]$/;

export type ParsedQuery = Record<string, string | Record<string, Record<string, string>>>;

export function parseQuery(search: URLSearchParams): ParsedQuery {
  const out: ParsedQuery = {};
  const filter: Record<string, Record<string, string>> = {};
  let hasFilter = false;
  for (const [name, value] of search) {
    const match = FILTER_KEY.exec(name);
    if (match !== null) {
      const field = match[1] as string;
      const op = match[2] as string;
      filter[field] = { ...filter[field], [op]: value };
      hasFilter = true;
      continue;
    }
    if (name.startsWith("filter[") || name === "filter") {
      // A malformed filter key is surfaced as an invalid filter rather than dropped.
      filter[name] = { "": value };
      hasFilter = true;
      continue;
    }
    if (!(name in out)) out[name] = value;
  }
  if (hasFilter) out["filter"] = filter;
  return out;
}
