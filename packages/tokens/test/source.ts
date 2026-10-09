import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Absolute path inside packages/tokens. */
export function pkgPath(relative: string): string {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

export function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(pkgPath(relative), "utf8")) as T;
}

export type TokenValue = string | Readonly<Record<string, string>>;

export interface SourceToken {
  readonly name: string;
  readonly value: TokenValue;
  readonly usage?: string;
}

export interface TypeStyle {
  readonly name: string;
  readonly fontSize: string;
  readonly lineHeight: number;
  readonly fontWeight: number;
}

export interface XosTokens {
  readonly color: {
    readonly themes: readonly { readonly id: string; readonly name: string }[];
    readonly tokens: readonly SourceToken[];
  };
  readonly type: {
    readonly families: Readonly<Record<string, string>>;
    readonly groups: readonly { readonly family: string; readonly styles: readonly TypeStyle[] }[];
  };
  readonly [group: string]: unknown;
}

/** Every token group in xos.tokens.json that carries a `tokens` list, keyed by group. */
export function tokenGroups(source: XosTokens): Map<string, readonly SourceToken[]> {
  const groups = new Map<string, readonly SourceToken[]>();
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "object" && value !== null && "tokens" in value) {
      groups.set(key, (value as { tokens: readonly SourceToken[] }).tokens);
    }
  }
  return groups;
}

export interface DtcgLeaf {
  readonly $type: string;
  readonly $value: unknown;
  readonly $description?: string;
}

/** Flattens a DTCG document to dotted paths, skipping `$` metadata keys. */
export function dtcgLeaves(doc: unknown, prefix = ""): Map<string, DtcgLeaf> {
  const out = new Map<string, DtcgLeaf>();
  if (typeof doc !== "object" || doc === null) return out;
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith("$") || typeof value !== "object" || value === null) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if ("$value" in value) out.set(path, value as DtcgLeaf);
    else for (const [p, leaf] of dtcgLeaves(value, path)) out.set(p, leaf);
  }
  return out;
}

export const THEMES = ["dark", "light", "sunlight"] as const;
export const THEMED_GROUPS = new Set(["color", "shadow"]);
