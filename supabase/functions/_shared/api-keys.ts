// Supabase's publishable and secret API keys, never the legacy ones in production (ADR 0168, D1 and D2).
export type EnvReader = (name: string) => string | undefined;
type Kind = "secret" | "publishable";

const KINDS = {
  secret: ["SUPABASE_SECRET_KEYS", "sb_secret_", "SUPABASE_SERVICE_ROLE_KEY"],
  publishable: ["SUPABASE_PUBLISHABLE_KEYS", "sb_publishable_", "SUPABASE_ANON_KEY"],
} as const;

/** The keys of one kind in a platform variable (a JSON object of name to key). */
export function namedKeys(raw: string | undefined, prefix: string): ReadonlyMap<string, string> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw ?? "null");
  } catch {
    // An unreadable value holds no key.
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
  return new Map(
    Object.entries(parsed).filter(
      (e): e is [string, string] => typeof e[1] === "string" && e[1].startsWith(prefix),
    ),
  );
}

/** The project's keys of a kind, `default` first; outside production, the local stack's legacy-named one. */
export function apiKeys(kind: Kind, read: EnvReader): readonly string[] {
  const [variable, prefix, local] = KINDS[kind];
  const named = namedKeys(read(variable), prefix);
  if (named.size > 0) {
    const first = named.get("default");
    const rest = [...named.values()].filter((key) => key !== first);
    return first === undefined ? rest : [first, ...rest];
  }
  if (read("XOS_ENVIRONMENT")?.trim().toLowerCase() === "production") return [];
  const fallback = read(local);
  return fallback ? [fallback] : [];
}

/** The key a function calls Supabase with; a thrown error names the missing variable. */
export function apiKey(kind: Kind, read: EnvReader): string {
  const [key] = apiKeys(kind, read);
  if (key === undefined) throw new Error(`${KINDS[kind][0]} is not set`);
  return key;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the apikey header, or a bearer, is exactly one of the secret keys. No token claim is trusted. */
export function carriesSecretKey(
  headers: { readonly apikey: string | null; readonly authorization: string | null },
  secretKeys: readonly string[],
): boolean {
  const auth = headers.authorization ?? "";
  const offered = [headers.apikey ?? "", auth.startsWith("Bearer ") ? auth.slice(7) : ""];
  return secretKeys.some(
    (key) => key !== "" && offered.some((value) => value !== "" && constantTimeEqual(value, key)),
  );
}
