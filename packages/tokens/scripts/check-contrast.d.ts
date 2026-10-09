/** Types for the contrast gate module (scripts/check-contrast.js). */

export interface ColorToken {
  readonly name: string;
  readonly value: string | Readonly<Record<string, string>>;
  readonly usage?: string;
}

export interface TokenSource {
  readonly color: {
    readonly themes: readonly { readonly id: string; readonly name: string }[];
    readonly tokens: readonly ColorToken[];
  };
}

export interface ContrastRule {
  readonly name: string;
  readonly min: number;
  readonly fg: readonly string[];
  readonly bg: readonly string[];
}

export interface ContrastSpec {
  readonly standard?: string;
  readonly note?: string;
  readonly rules: readonly ContrastRule[];
}

export interface ContrastFailure {
  readonly theme: string;
  readonly rule: string;
  readonly fg: string;
  readonly bg: string;
  readonly ratio: number;
  readonly min: number;
}

export interface ContrastResult {
  readonly checked: number;
  readonly themes: number;
  readonly failures: readonly ContrastFailure[];
}

export function ratio(a: string, b: string): number;
export function resolveColor(tokens: TokenSource, name: string, theme: string): string;
export function checkContrast(tokens: TokenSource, spec: ContrastSpec): ContrastResult;
export function formatFailure(failure: ContrastFailure): string;
