/**
 * Pass colors (A93, RRR-138), read from packages/tokens like every design value (Section 3.15): the pass is
 * the org's accent with the on-accent label color, or the platform accent when the org has none or its
 * accent fails the "Label on accent fill" contrast pair (WCAG 2.2 AA, 4.5:1) under white labels.
 */
import tokens from "@xos/tokens/tokens.json" with { type: "json" };
import { ratio } from "@xos/tokens/ratio";

interface ColorToken {
  readonly name: string;
  readonly value: string | { readonly light?: string };
}

const colorTokens = tokens.color.tokens as readonly ColorToken[];

/** A color token's Light theme value, following `{other-token}` references. */
function lightColor(name: string): string {
  const token = colorTokens.find((t) => t.name === name);
  const value = typeof token?.value === "string" ? token.value : token?.value.light;
  if (!value) throw new Error(`Unknown color token ${name}`);
  const ref = /^\{(.+)\}$/.exec(value);
  return ref?.[1] ? lightColor(ref[1]) : value.toUpperCase();
}

export const PLATFORM_ACCENT = lightColor("accent-default");
export const ON_ACCENT = lightColor("accent-text-on");

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** The pass background: the org's accent when on-accent labels read on it, else the platform accent. */
export function passBackground(accentHex: string | null): string {
  if (!accentHex || !HEX.test(accentHex)) return PLATFORM_ACCENT;
  return ratio(ON_ACCENT, accentHex) >= 4.5 ? accentHex.toUpperCase() : PLATFORM_ACCENT;
}

/** The CSS function name Apple's pass.json spells colors with. */
const TRIPLE = "rgb";

/** A #RRGGBB color as the CSS rgb() triple pass.json takes. */
export function cssTriple(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
  return `${TRIPLE}(${String(r)}, ${String(g)}, ${String(b)})`;
}
