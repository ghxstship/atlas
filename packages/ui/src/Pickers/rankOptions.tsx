import { defaultFilter } from "cmdk";
import type { Option } from "../types/reference";

/** Ranks options against a query with cmdk's fuzzy score; an empty query keeps the given order. */
export function rankOptions(options: Option[], query: string): Option[] {
  if (!query.trim()) return options;
  return options
    .map((o) => ({ o, score: defaultFilter(`${o.label} ${o.code ?? ""}`, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.o);
}
