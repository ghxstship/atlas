/**
 * The docs brand lookup (A138, ADR 0066), for the proxy only: it reads the token contrast gate, which
 * the browser never loads. lib/brand.ts holds what the page shares with the proxy.
 */
import {
  checkContrast,
  type ContrastRule,
  type ContrastSpec,
  type TokenSource,
} from "@xos/tokens/contrast";
import pairs from "@xos/tokens/contrast-pairs.json" with { type: "json" };
import tokens from "@xos/tokens/tokens.json" with { type: "json" };
import { HEX_COLOR, type DocsBrand } from "./brand.ts";

/** Only the contrast rules that pair the accent with something, narrowed to the accent's side (as Gateway). */
function accentRules(spec: ContrastSpec): ContrastSpec {
  return {
    rules: spec.rules.flatMap((rule): ContrastRule[] => {
      if (rule.fg.includes("accent-default")) return [{ ...rule, fg: ["accent-default"] }];
      if (rule.bg.includes("accent-default")) return [{ ...rule, bg: ["accent-default"] }];
      return [];
    }),
  };
}

/**
 * An org accent the docs site may apply: it replaces accent-default in every theme, so it must pass
 * every declared pair involving the accent in every theme, the gate Atlas and Gateway apply
 * (Section 12, ADR 0009). Null for a failing or malformed accent; the platform accent stays.
 */
export function docsAccent(hex: string | null | undefined): string | null {
  if (typeof hex !== "string" || !HEX_COLOR.test(hex.toUpperCase())) return null;
  const accent = hex.toUpperCase();
  const source = tokens as unknown as TokenSource;
  const themes = source.color.themes.map((t) => t.id);
  const result = checkContrast(
    {
      color: {
        themes: source.color.themes,
        tokens: source.color.tokens.map((token) =>
          token.name === "accent-default"
            ? { ...token, value: Object.fromEntries(themes.map((id) => [id, accent])) }
            : token,
        ),
      },
    },
    accentRules(pairs as unknown as ContrastSpec),
  );
  return result.failures.length === 0 ? accent : null;
}

/** Public URL of an object in the org-brand bucket. */
export function brandAssetUrl(supabaseUrl: string, path: string | null): string | null {
  if (!path) return null;
  const base = supabaseUrl.replace(/\/$/, "");
  return `${base}/storage/v1/object/public/org-brand/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export interface BrandLookupOptions {
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly fetch?: typeof fetch;
}

/**
 * Looks an org's docs brand up through api_public.docs_brand_for_slug with the anon key. Null when
 * the org has none (not Enterprise, no white label in force, or no such org). A failed call throws.
 */
export async function fetchDocsBrand(
  slug: string,
  options: BrandLookupOptions,
): Promise<DocsBrand | null> {
  const base = options.supabaseUrl.replace(/\/$/, "");
  const response = await (options.fetch ?? fetch)(`${base}/rest/v1/rpc/docs_brand_for_slug`, {
    method: "POST",
    headers: {
      apikey: options.anonKey,
      "content-type": "application/json",
      "content-profile": "api_public",
      accept: "application/json",
    },
    body: JSON.stringify({ p_org_slug: slug }),
  });
  if (!response.ok) throw new Error(`docs_brand_for_slug answered ${response.status}`);
  const rows = (await response.json()) as unknown;
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  if (!row || typeof row["name"] !== "string") return null;
  const str = (key: string) => (typeof row[key] === "string" ? (row[key] as string) : null);
  return {
    name: row["name"],
    logoLightUrl: brandAssetUrl(base, str("logo_light_path")),
    logoDarkUrl: brandAssetUrl(base, str("logo_dark_path")),
    accent: docsAccent(str("accent_hex")),
  };
}
