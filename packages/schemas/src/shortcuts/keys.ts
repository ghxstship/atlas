/**
 * Key grammar of the shortcut registry (packages/schemas/shortcuts.yaml): parsing, the canonical form,
 * the chord a keyboard event makes, platform display and reserved-key matching. Pure functions with no
 * registry data, so a shell's key handler can import this file alone and stay small.
 *
 * A binding is one chord or a two-step sequence written with a space (`G H` is G then H). A chord is
 * zero or more modifiers in the order Mod, Ctrl, Alt, Shift, then one key, joined with `+`. Mod is
 * Command on macOS and Control elsewhere; Ctrl is the Control key on macOS and the same key as Mod
 * elsewhere. Shift goes only with letters and named keys, since a symbol such as ? already carries it.
 */

export type Platform = "mac" | "other";

export const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift"] as const;
export type Modifier = (typeof MODIFIERS)[number];

/** Keys with a name rather than a character. `Plus` is the + key, since + joins a chord. */
export const NAMED_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "CapsLock",
  "Plus",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
] as const;

const NAMED = new Set<string>(NAMED_KEYS);
/** Keys that take Shift: letters and named keys other than Plus, which types a symbol. */
function takesShift(key: string): boolean {
  return LETTER.test(key) || (NAMED.has(key) && key !== "Plus");
}
const LETTER = /^[A-Z]$/;
const DIGIT = /^[0-9]$/;
/** Printable ASCII symbols other than + and space. */
const SYMBOL = /^[!-*,-/:-@[-`{-~]$/;

export interface Chord {
  readonly modifiers: readonly Modifier[];
  readonly key: string;
}

function parseChord(text: string): Chord | null {
  if (text === "") return null;
  const parts = text.split("+");
  const key = parts.pop() as string;
  const modifiers = parts as Modifier[];
  if (key === "" || modifiers.some((m) => !(MODIFIERS as readonly string[]).includes(m))) {
    return null;
  }
  // Modifiers appear once each, in canonical order.
  const order = modifiers.map((m) => MODIFIERS.indexOf(m));
  if (order.some((o, i) => i > 0 && o <= (order[i - 1] as number))) return null;
  if (!(LETTER.test(key) || DIGIT.test(key) || SYMBOL.test(key) || NAMED.has(key))) return null;
  if (modifiers.includes("Shift") && !takesShift(key)) return null;
  return { modifiers, key };
}

/**
 * The steps of a binding, or null when the text is not in the grammar. A sequence has two steps and
 * starts with one letter without modifiers.
 */
export function parseKeys(text: string): readonly Chord[] | null {
  if (text.length === 0 || text.length > 40) return null;
  const steps = text.split(" ");
  if (steps.length > 2) return null;
  const chords = steps.map(parseChord);
  if (chords.some((c) => c === null)) return null;
  const parsed = chords as Chord[];
  if (parsed.length === 2) {
    const first = parsed[0] as Chord;
    if (first.modifiers.length > 0 || !LETTER.test(first.key)) return null;
  }
  return parsed;
}

export function isValidKeys(text: string): boolean {
  return parseKeys(text) !== null;
}

function formatChord(chord: Chord): string {
  return [...chord.modifiers, chord.key].join("+");
}

/**
 * The binding as the given platform's key handler sees it. Elsewhere than macOS the Control key is
 * Mod, so `Ctrl+X` and `Mod+X` are the same keys there.
 */
export function normalizeKeys(text: string, platform: Platform): string | null {
  const steps = parseKeys(text);
  if (!steps) return null;
  return steps
    .map((step) => {
      if (platform === "mac" || !step.modifiers.includes("Ctrl")) return formatChord(step);
      const held = new Set<Modifier>(step.modifiers);
      held.delete("Ctrl");
      held.add("Mod");
      return formatChord({ modifiers: MODIFIERS.filter((m) => held.has(m)), key: step.key });
    })
    .join(" ");
}

/** True when the binding's first step holds Mod, Ctrl or Alt, so it types no character. */
export function isModifierChord(text: string): boolean {
  const first = parseKeys(text)?.[0];
  return first !== undefined && first.modifiers.some((m) => m !== "Shift");
}

/** The keyboard event fields chordOf reads; a DOM KeyboardEvent has them all. */
export interface KeyEventLike {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const EVENT_NAMES: Readonly<Record<string, string>> = {
  " ": "Space",
  "+": "Plus",
  Esc: "Escape",
  Spacebar: "Space",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Del: "Delete",
};

function eventKey(event: KeyEventLike): string | null {
  const named = EVENT_NAMES[event.key] ?? event.key;
  if (NAMED.has(named)) return named;
  // Option on macOS and other keyboard layouts type characters a letter shortcut must not depend on;
  // the physical key decides then.
  const physical =
    /^Key([A-Z])$/.exec(event.code ?? "")?.[1] ?? /^Digit([0-9])$/.exec(event.code ?? "")?.[1];
  if (named.length !== 1) return null;
  const upper = named.toUpperCase();
  if (LETTER.test(upper) && !event.altKey) return upper;
  if (physical && (event.altKey || !/^[!-~]$/.test(named))) return physical;
  if (DIGIT.test(named) || SYMBOL.test(named)) return named;
  return null;
}

/**
 * The chord a key press makes on a platform, in the canonical form, or null for a lone modifier, a
 * dead key or a key outside the grammar. Elsewhere than macOS the Windows or Super key is left to the
 * operating system, so a press holding it makes no chord.
 */
export function chordOf(event: KeyEventLike, platform: Platform): string | null {
  const key = eventKey(event);
  if (key === null) return null;
  const modifiers: Modifier[] = [];
  if (platform === "mac") {
    if (event.metaKey) modifiers.push("Mod");
    if (event.ctrlKey) modifiers.push("Ctrl");
  } else {
    if (event.metaKey) return null;
    if (event.ctrlKey) modifiers.push("Mod");
  }
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey && takesShift(key)) modifiers.push("Shift");
  return formatChord({ modifiers, key });
}

const MAC_SYMBOLS: Readonly<Record<string, string>> = {
  Mod: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
};

const KEY_DISPLAY: Readonly<Record<string, string>> = {
  Escape: "Esc",
  Plus: "+",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Backspace: "⌫",
};

/**
 * The binding as people read it on a platform, one key cap per space-separated part, for the Keys
 * component: `Mod+K` is `⌘ K` on macOS and `Ctrl K` elsewhere; `G H` stays `G H`.
 */
export function displayKeys(text: string, platform: Platform): string {
  const normalized = normalizeKeys(text, platform);
  const steps = normalized === null ? null : parseKeys(normalized);
  if (!steps) return text;
  return steps
    .flatMap((step) => [
      ...step.modifiers.map((m) =>
        platform === "mac" ? (MAC_SYMBOLS[m] as string) : m === "Mod" ? "Ctrl" : m,
      ),
      KEY_DISPLAY[step.key] ?? step.key,
    ])
    .join(" ");
}

/** The platform of a browser, from what the navigator reports; anything not Apple is `other`. */
export function platformOf(navigatorLike: {
  readonly platform?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly userAgentData?: { readonly platform?: string | undefined } | undefined;
}): Platform {
  const reported =
    navigatorLike.userAgentData?.platform ??
    navigatorLike.platform ??
    navigatorLike.userAgent ??
    "";
  return /mac|iphone|ipad|ipod/i.test(reported) ? "mac" : "other";
}

/**
 * Whether a binding uses reserved keys in either step: the same chord, or, for a pattern ending in
 * `+*`, any key pressed while holding at least those modifiers (VoiceOver's Control and Option). Both
 * sides are compared as the platform's key handler sees them.
 */
export function matchesReserved(keys: string, reserved: string, platform: Platform): boolean {
  const normalized = normalizeKeys(keys, platform);
  if (normalized === null) return false;
  const steps = normalized.split(" ");
  if (reserved.endsWith("+*")) {
    const pattern = parseKeys(normalizeKeys(`${reserved.slice(0, -1)}A`, platform) ?? "")?.[0];
    if (pattern === undefined) return false;
    return steps.some((step) => {
      const held = parseKeys(step)?.[0]?.modifiers ?? [];
      return pattern.modifiers.every((m) => held.includes(m));
    });
  }
  const target = normalizeKeys(reserved, platform);
  return target !== null && steps.includes(target);
}
