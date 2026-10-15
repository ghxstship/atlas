import type { Route } from "next";

/** Query-string helpers for the Credentials and Safety incident collections. */

export type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** Joins the present parts of a label with a middle dot, the separator every list here uses. */
export function joined(...parts: readonly (string | number | null | undefined)[]): string {
  return parts.filter((p) => p !== null && p !== undefined && p !== "").join(" · ");
}

/** The first value of a query parameter. */
export function param(search: SearchParams, name: string): string | undefined {
  const value = search[name];
  return Array.isArray(value) ? value[0] : value;
}

/** A link to the same page with some query parameters replaced; undefined removes one. */
export function hrefWith(
  base: string,
  search: SearchParams,
  changes: Readonly<Record<string, string | undefined>>,
): Route {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined && !(key in changes)) query.set(key, first);
  }
  for (const [key, value] of Object.entries(changes))
    if (value !== undefined) query.set(key, value);
  const text = query.toString();
  return (text ? `${base}?${text}` : base) as Route;
}
