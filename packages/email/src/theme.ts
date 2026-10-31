import { ratio } from "@xos/tokens/ratio";
import tokens from "@xos/tokens/tokens.json" with { type: "json" };

/**
 * Email design values, read from packages/tokens (Section 3.15). Email clients ignore CSS variables,
 * so templates inline resolved values from the Light theme, the theme every mail client renders
 * reliably. Nothing here restates a value; every entry is looked up by token name.
 */

interface ColorToken {
  readonly name: string;
  readonly value: string | { readonly light?: string };
}

interface NamedValue {
  readonly name: string;
  readonly value: string;
}

interface TypeStyle {
  readonly name: string;
  readonly fontSize: string;
  readonly lineHeight: number;
  readonly fontWeight: number;
}

const colorTokens = tokens.color.tokens as readonly ColorToken[];
const spacingTokens = tokens.spacing.tokens as readonly NamedValue[];
const radiusTokens = tokens.radius.tokens as readonly NamedValue[];
const strokeTokens = tokens.strokeWidth.tokens as readonly NamedValue[];
const layoutTokens = tokens.layout.tokens as readonly NamedValue[];
const typeStyles = (
  tokens.type.groups as readonly { readonly styles: readonly TypeStyle[] }[]
).flatMap((g) => g.styles);

/** Resolves a color token in the Light theme, following `{other-token}` references. */
export function color(name: string, seen: ReadonlySet<string> = new Set()): string {
  const token = colorTokens.find((t) => t.name === name);
  if (token === undefined) throw new Error(`Unknown color token ${name}`);
  const raw = typeof token.value === "string" ? token.value : token.value.light;
  if (raw === undefined) throw new Error(`Color token ${name} has no light value`);
  const reference = /^\{([a-z0-9-]+)\}$/.exec(raw);
  if (reference?.[1] !== undefined) {
    if (seen.has(name)) throw new Error(`Color token ${name} references itself`);
    return color(reference[1], new Set([...seen, name]));
  }
  return raw;
}

function named(list: readonly NamedValue[], name: string, kind: string): string {
  const token = list.find((t) => t.name === name);
  if (token === undefined) throw new Error(`Unknown ${kind} token ${name}`);
  return token.value;
}

/** A spacing token such as space-16. */
export function space(name: string): string {
  return named(spacingTokens, name, "spacing");
}

/** A radius token such as radius-control. */
export function radius(name: string): string {
  return named(radiusTokens, name, "radius");
}

/** A stroke width token such as stroke-hairline. */
export function stroke(name: string): string {
  return named(strokeTokens, name, "stroke");
}

/** A layout token such as layout-form. */
export function layout(name: string): string {
  return named(layoutTokens, name, "layout");
}

/** A type style such as text-14, as inline style properties. */
export function text(name: string): { fontSize: string; lineHeight: number; fontWeight: number } {
  const style = typeStyles.find((s) => s.name === name);
  if (style === undefined) throw new Error(`Unknown type style ${name}`);
  return { fontSize: style.fontSize, lineHeight: style.lineHeight, fontWeight: style.fontWeight };
}

/** The sans font stack. */
export const fontFamily: string = tokens.type.families.sans;

/**
 * An org's accent for its email (A138, Section 12), or null when it fails the contrast check, so the
 * email keeps the platform accent. Email renders in the Light theme only, so the accent is checked
 * there against the two pairs the email draws with it, at the thresholds of the token gate
 * (contrast-pairs.json): the button label on the accent fill at 4.5:1, and the accent fill against
 * the surface and raised grounds at 3:1.
 */
export function brandAccent(hex: string | null | undefined): string | null {
  if (hex === null || hex === undefined || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const accent = hex.toUpperCase();
  const label = ratio(color("accent-text-on"), accent) >= 4.5;
  const grounds = ["bg-surface", "bg-raised"].every((g) => ratio(accent, color(g)) >= 3);
  return label && grounds ? accent : null;
}
