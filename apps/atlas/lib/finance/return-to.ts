/**
 * Where a recording returns to, read from the form that made it: only a path inside the org, so a posted value can never
 * send the person elsewhere. `set` adds what only the server knows, such as a new record's id. Null when the value is
 * anything else.
 */
export function returnHref(
  value: unknown,
  orgSlug: string,
  set: Readonly<Record<string, string>> = {},
): string | null {
  if (typeof value !== "string" || !value.startsWith(`/${orgSlug}/`)) return null;
  const base = "https://return.invalid";
  const url = new URL(value, base);
  if (url.origin !== base || !url.pathname.startsWith(`/${orgSlug}/`)) return null;
  for (const [key, next] of Object.entries(set)) url.searchParams.set(key, next);
  return `${url.pathname}${url.search}`;
}
