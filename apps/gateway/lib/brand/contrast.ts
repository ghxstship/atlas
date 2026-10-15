import {
  checkContrast,
  type ContrastFailure,
  type ContrastRule,
  type ContrastSpec,
  type TokenSource,
} from "@xos/tokens/contrast";
import pairs from "@xos/tokens/contrast-pairs.json" with { type: "json" };
import tokens from "@xos/tokens/tokens.json" with { type: "json" };

/**
 * The white-label contrast gate (Section 12, ADR 0009): a brand accent replaces `accent-default` in
 * every theme, and every declared pair that involves the accent is checked with the same arithmetic
 * and thresholds as the token build. A failing accent is blocked; the editor shows each failure.
 */
export const ACCENT_TOKEN = "accent-default";
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export interface AccentCheck {
  readonly passes: boolean;
  readonly checked: number;
  readonly failures: readonly ContrastFailure[];
}

function withAccent(source: TokenSource, accent: string): TokenSource {
  const themes = source.color.themes.map((t) => t.id);
  return {
    color: {
      themes: source.color.themes,
      tokens: source.color.tokens.map((token) =>
        token.name === ACCENT_TOKEN
          ? { ...token, value: Object.fromEntries(themes.map((id) => [id, accent])) }
          : token,
      ),
    },
  };
}

/** Only the rules that pair the accent with something, narrowed to the accent's side. */
function accentRules(spec: ContrastSpec): ContrastSpec {
  return {
    rules: spec.rules.flatMap((rule): ContrastRule[] => {
      if (rule.fg.includes(ACCENT_TOKEN)) return [{ ...rule, fg: [ACCENT_TOKEN] }];
      if (rule.bg.includes(ACCENT_TOKEN)) return [{ ...rule, bg: [ACCENT_TOKEN] }];
      return [];
    }),
  };
}

export function checkAccent(accent: string): AccentCheck {
  if (!HEX_COLOR.test(accent)) throw new Error(`Not a six-digit hex color: ${accent}`);
  const result = checkContrast(
    withAccent(tokens as unknown as TokenSource, accent.toUpperCase()),
    accentRules(pairs as unknown as ContrastSpec),
  );
  return {
    passes: result.failures.length === 0,
    checked: result.checked,
    failures: result.failures,
  };
}

/** The platform's own accent in the dark theme, the editor's starting value. */
export function defaultAccent(): string {
  const token = (tokens as unknown as TokenSource).color.tokens.find(
    (t) => t.name === ACCENT_TOKEN,
  );
  const value = token?.value;
  return typeof value === "string" ? value : (value?.["dark"] ?? "");
}
