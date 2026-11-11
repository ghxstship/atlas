import {
  checkContrast,
  resolveColor,
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

/**
 * One pair the gate checks, with the accent's counterpart resolved to its hex in a theme: the form
 * @xos/ui ColorPicker measures live in the brand editor (A142). The picker passes exactly when
 * {@link checkAccent} does, since both run the token build's arithmetic on the same pairs.
 */
export interface AccentPair {
  readonly theme: string;
  readonly rule: string;
  /** The token the accent is paired with. */
  readonly counterpart: string;
  /** A hover or pressed overlay drawn over the accent fill, when the rule declares one. */
  readonly state: string | null;
  /** The counterpart's hex: the label color on an accent fill, or the ground under an accent mark. */
  readonly fg?: string;
  readonly bg?: string;
  /** True when the accent is the foreground (a mark on a ground). */
  readonly fgIsValue: boolean;
  readonly min: number;
  readonly overlay?: { readonly color: string; readonly opacity: number };
}

export function accentPairs(): readonly AccentPair[] {
  const source = tokens as unknown as TokenSource;
  const themes = source.color.themes.map((t) => t.id);
  const rules = accentRules(pairs as unknown as ContrastSpec).rules;
  return themes.flatMap((theme) =>
    rules.flatMap((rule) => {
      const accentIsFg = rule.fg.includes(ACCENT_TOKEN);
      const others = accentIsFg ? rule.bg : rule.fg;
      return others.flatMap((counterpart): AccentPair[] => {
        const hex = resolveColor(source, counterpart, theme);
        const plain: AccentPair = {
          theme,
          rule: rule.name,
          counterpart,
          state: null,
          ...(accentIsFg ? { bg: hex } : { fg: hex }),
          fgIsValue: accentIsFg,
          min: rule.min,
        };
        // As the gate does, each overlay is composited over the background before measuring.
        return [
          plain,
          ...(rule.overlays ?? []).map((o) => ({
            ...plain,
            state: o.state,
            overlay: { color: resolveColor(source, o.color, theme), opacity: o.opacity },
          })),
        ];
      });
    }),
  );
}

/** The platform's own accent in the dark theme, the editor's starting value. */
export function defaultAccent(): string {
  const token = (tokens as unknown as TokenSource).color.tokens.find(
    (t) => t.name === ACCENT_TOKEN,
  );
  const value = token?.value;
  return typeof value === "string" ? value : (value?.["dark"] ?? "");
}
