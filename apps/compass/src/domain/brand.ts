/**
 * The tenant brand at runtime (Section 12 Mobile: "Standard Compass applies the tenant brand at runtime after
 * sign-in"). app.my_org_brands (1500) gives the public brand of every org the person works in: name, light
 * and dark logos and accent. The active org's brand themes Compass; every org's brand marks its items on
 * the combined Today (Section 4.5.7 brand chips).
 *
 * Every override is token-based and checked against the design tokens' contrast pairs (Section 12, ADR
 * 0009), the same pairs and thresholds the token build and the Atlas and Gateway theme editors use: the
 * accent replaces accent-default, and accent-text where it also passes as body text. A theme in which the
 * accent fails any pair keeps the platform accent, so a failing palette never renders and the platform brand
 * is always the fallback.
 */
import pairs from "@xos/tokens/contrast-pairs.json";
import { ratio } from "@xos/tokens/ratio";
import tokens from "@xos/tokens/tokens.json";

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export type BrandTheme = "dark" | "light" | "sunlight";
export const BRAND_THEMES: readonly BrandTheme[] = ["dark", "light", "sunlight"];

export interface OrgBrand {
  readonly orgId: string;
  readonly name: string;
  readonly accentHex: string | null;
  readonly logoLightPath: string | null;
  readonly logoDarkPath: string | null;
}

/** The colors a brand changes in one theme, as ui-native color token names. */
export interface BrandThemeColors {
  readonly accentDefault: string;
  readonly accentText?: string;
}

export type BrandColors = Readonly<Partial<Record<BrandTheme, BrandThemeColors>>>;

interface TokenSource {
  readonly color: {
    readonly themes: readonly { readonly id: string }[];
    readonly tokens: readonly {
      readonly name: string;
      readonly value: string | Readonly<Record<string, string>>;
    }[];
  };
}

interface ContrastRule {
  readonly name: string;
  readonly min: number;
  readonly fg: readonly string[];
  readonly bg: readonly string[];
  readonly overlays?: readonly {
    readonly state: string;
    readonly color: string;
    readonly opacity: number;
  }[];
}

const SOURCE = tokens as unknown as TokenSource;
const RULES = (pairs as unknown as { readonly rules: readonly ContrastRule[] }).rules;
const TOKENS = new Map(SOURCE.color.tokens.map((t) => [t.name, t.value]));

/** A token's hex in a theme with overrides applied, following `{name}` references. */
function resolve(
  name: string,
  theme: BrandTheme,
  overrides: Readonly<Record<string, string>>,
): string {
  const override = overrides[name];
  if (override) return override;
  const value = TOKENS.get(name);
  if (value === undefined) throw new Error(`Unknown color token: ${name}`);
  const raw = typeof value === "string" ? value : (value[theme] ?? Object.values(value)[0] ?? "");
  const ref = /^\{(.+)\}$/.exec(raw);
  return ref?.[1] ? resolve(ref[1], theme, overrides) : raw;
}

/** An overlay composited over a fill, as hover and pressed states draw it (the token gate's arithmetic). */
function composite(fill: string, overlay: string, opacity: number): string {
  const channels = (hex: string) =>
    [0, 2, 4].map((i) => parseInt(hex.replace("#", "").substring(i, i + 2), 16));
  const over = channels(overlay);
  return `#${channels(fill)
    .map((c, i) => Math.round(c * (1 - opacity) + (over[i] ?? 0) * opacity))
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`;
}

export interface ContrastFailure {
  readonly theme: BrandTheme;
  readonly rule: string;
  readonly fg: string;
  readonly bg: string;
  readonly ratio: number;
  readonly min: number;
}

/**
 * Every declared pair that falls under its threshold in a theme once the overrides apply. The platform
 * tokens pass every pair (the token build's gate), so each failure is the override's.
 */
export function contrastFailures(
  theme: BrandTheme,
  overrides: Readonly<Record<string, string>>,
): ContrastFailure[] {
  const failures: ContrastFailure[] = [];
  for (const rule of RULES) {
    for (const fg of rule.fg) {
      for (const bg of rule.bg) {
        const fill = resolve(bg, theme, overrides);
        const states = [
          { label: bg, hex: fill },
          ...(rule.overlays ?? []).map((o) => ({
            label: `${bg} ${o.state}`,
            hex: composite(fill, resolve(o.color, theme, overrides), o.opacity),
          })),
        ];
        for (const state of states) {
          const r = ratio(resolve(fg, theme, overrides), state.hex);
          if (r < rule.min)
            failures.push({ theme, rule: rule.name, fg, bg: state.label, ratio: r, min: rule.min });
        }
      }
    }
  }
  return failures;
}

/** The brand's colors per theme: only themes where the accent passes every pair; the rest keep the platform's. */
export function brandColors(brand: OrgBrand | null | undefined): BrandColors {
  const accent = brand?.accentHex;
  if (!accent || !HEX_COLOR.test(accent)) return {};
  const hex = accent.toUpperCase();
  const out: Partial<Record<BrandTheme, BrandThemeColors>> = {};
  for (const theme of BRAND_THEMES) {
    if (contrastFailures(theme, { "accent-default": hex }).length > 0) continue;
    const asText =
      contrastFailures(theme, { "accent-default": hex, "accent-text": hex }).length === 0;
    out[theme] = asText ? { accentDefault: hex, accentText: hex } : { accentDefault: hex };
  }
  return out;
}

/** A brand row from app.my_org_brands, or null when it is not one. */
export function brandFromRow(row: Readonly<Record<string, unknown>>): OrgBrand | null {
  const orgId = row["org_id"];
  const name = row["name"];
  if (typeof orgId !== "string" || typeof name !== "string") return null;
  const text = (key: string) => {
    const value = row[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const accent = text("accent_hex");
  return {
    orgId,
    name,
    accentHex: accent && HEX_COLOR.test(accent) ? accent.toUpperCase() : null,
    logoLightPath: text("logo_light_path"),
    logoDarkPath: text("logo_dark_path"),
  };
}

/** The public URL of a logo in the org-brand bucket (public by design, 0850 and 1265). */
export function logoUrl(supabaseUrl: string, path: string | null): string | null {
  if (!path || !/^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,120}$/.test(path)) return null;
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/org-brand/${path}`;
}

/** The logo for a theme: the dark logo on the dark theme when there is one, else the light logo. */
export function logoFor(brand: OrgBrand | null | undefined, dark: boolean): string | null {
  if (!brand) return null;
  return (dark ? brand.logoDarkPath : null) ?? brand.logoLightPath ?? brand.logoDarkPath;
}

/** The color of an org's brand chip in a theme: its accent when it passes there, else none (neutral). */
export function chipColor(brand: OrgBrand | null | undefined, theme: BrandTheme): string | null {
  return brandColors(brand)[theme]?.accentDefault ?? null;
}
