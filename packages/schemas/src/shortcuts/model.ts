import {
  isModifierChord,
  matchesReserved,
  normalizeKeys,
  parseKeys,
  type Platform,
} from "./keys.ts";

/**
 * The keyboard shortcut registry model (Section 3.15, Section 11.2 principle 1, Section 11.7): one
 * registry per web shell, the reserved keys, and the rules that refuse a conflicting or reserved
 * binding. Pure functions only, so the shells, the rebinding editor, the server action that saves a
 * binding and the tests share them.
 */

export const SHORTCUT_SHELLS = ["atlas", "gateway"] as const;
export type ShortcutShell = (typeof SHORTCUT_SHELLS)[number];

/** The app.shortcut_shell label a personal binding stores (migration 1370). */
export const SHELL_LABELS: Readonly<Record<ShortcutShell, "Atlas" | "Gateway">> = {
  atlas: "Atlas",
  gateway: "Gateway",
};

export const PLATFORMS: readonly Platform[] = ["mac", "other"];

/** The scope every other scope meets: its shortcuts answer anywhere in the shell. */
export const GLOBAL_SCOPE = "global";

export const RESERVED_REASONS = ["browser", "screen-reader", "navigation"] as const;
export type ReservedReason = (typeof RESERVED_REASONS)[number];

export interface ReservedKeys {
  /** A binding, or modifiers followed by `+*` for any key under them. */
  readonly keys: string;
  readonly reason: ReservedReason;
  /** The platform the keys are reserved on; null for both. */
  readonly platform: Platform | null;
}

export interface ShortcutGroup {
  readonly id: string;
  /** i18n key of the shortcut sheet section. */
  readonly label: string;
}

export interface ShortcutDefinition {
  /** Stable id; personal bindings store it. */
  readonly id: string;
  readonly scope: string;
  readonly group: string;
  /** Default keys, or null for an action with no default that a person may bind. */
  readonly keys: string | null;
  /** Default keys on macOS when they differ from `keys`. */
  readonly mac: string | null;
  /** i18n key of the action's name. */
  readonly label: string;
  /** True when the shortcut also works while typing in a field; modifier chords only. */
  readonly fields: boolean;
  /** True when the keys cannot be rebound. */
  readonly fixed: boolean;
  /** For a navigation shortcut, the sitemap node it opens. */
  readonly go: string | null;
}

export interface ShellShortcuts {
  readonly scopes: readonly string[];
  readonly groups: readonly ShortcutGroup[];
  readonly shortcuts: readonly ShortcutDefinition[];
}

export interface ShortcutRegistry {
  readonly reserved: readonly ReservedKeys[];
  readonly shells: Readonly<Record<ShortcutShell, ShellShortcuts>>;
}

/** Keys a person chose, by shortcut id; null unbinds a shortcut that has default keys. */
export type CustomBindings = Readonly<Record<string, string | null>>;

/** The default keys of a shortcut on a platform. */
export function defaultKeys(shortcut: ShortcutDefinition, platform: Platform): string | null {
  return platform === "mac" && shortcut.mac !== null ? shortcut.mac : shortcut.keys;
}

/**
 * Every shortcut's keys for one person on a platform: their own binding where they chose one, the
 * default otherwise. Bindings for fixed shortcuts and for ids the registry no longer has are ignored.
 */
export function effectiveBindings(
  shell: ShellShortcuts,
  custom: CustomBindings,
  platform: Platform,
): ReadonlyMap<string, string | null> {
  const out = new Map<string, string | null>();
  for (const shortcut of shell.shortcuts) {
    const chosen = !shortcut.fixed && Object.hasOwn(custom, shortcut.id);
    out.set(shortcut.id, chosen ? (custom[shortcut.id] ?? null) : defaultKeys(shortcut, platform));
  }
  return out;
}

/**
 * The scope whose keys the design system's lists own (RecordList, RecordRow, DataTable). A list can
 * sit in any region (a collection's rows, a record's related items, the Inbox), and the list takes its
 * keys before the shell sees them, so no other scope may bind them.
 */
const LIST_SCOPE = "list";

/**
 * Scopes whose region never holds a design system list. The showcaller console (ADR 0131) is its own
 * region beside the cue list, and its J and K move the standby rather than the list focus.
 */
const LISTLESS_SCOPES: ReadonlySet<string> = new Set(["show"]);

/**
 * Whether two scopes can both be active at once: the same scope, either one global, or either one
 * the list scope, which every region may hold except a listless one.
 */
export function scopesMeet(a: string, b: string): boolean {
  if (a === b || a === GLOBAL_SCOPE || b === GLOBAL_SCOPE) return true;
  if (a === LIST_SCOPE) return !LISTLESS_SCOPES.has(b);
  if (b === LIST_SCOPE) return !LISTLESS_SCOPES.has(a);
  return false;
}

/**
 * Whether two bindings clash on a platform: the same keys, or one is the first step of the other's
 * sequence (pressing G would never wait for the H of G H).
 */
export function keysClash(a: string, b: string, platform: Platform): boolean {
  const x = normalizeKeys(a, platform);
  const y = normalizeKeys(b, platform);
  if (x === null || y === null) return false;
  if (x === y) return true;
  const xs = x.split(" ");
  const ys = y.split(" ");
  return (xs.length === 1 && ys[0] === x) || (ys.length === 1 && xs[0] === y);
}

export type BindingProblem =
  | { readonly kind: "unknown" }
  | { readonly kind: "fixed" }
  | { readonly kind: "invalid" }
  | { readonly kind: "typing" }
  | { readonly kind: "reserved"; readonly reason: ReservedReason }
  | { readonly kind: "conflict"; readonly with: string };

/**
 * Why a shortcut cannot take these keys, or null when it can. The keys must be in the grammar, not
 * reserved on any platform, and clash with no other shortcut whose scope meets this one's, as each
 * platform's handler sees them; a shortcut that works in fields must keep a modifier so it never
 * swallows typed text. `current` holds every shortcut's keys as they stand (effectiveBindings).
 */
export function bindingProblem(
  registry: ShortcutRegistry,
  shellId: ShortcutShell,
  current: (platform: Platform) => ReadonlyMap<string, string | null>,
  id: string,
  keys: string,
): BindingProblem | null {
  const shell = registry.shells[shellId];
  const shortcut = shell.shortcuts.find((s) => s.id === id);
  if (!shortcut) return { kind: "unknown" };
  if (shortcut.fixed) return { kind: "fixed" };
  if (parseKeys(keys) === null) return { kind: "invalid" };
  if (shortcut.fields && !isModifierChord(keys)) return { kind: "typing" };
  for (const platform of PLATFORMS) {
    for (const reserved of registry.reserved) {
      if (reserved.platform !== null && reserved.platform !== platform) continue;
      if (matchesReserved(keys, reserved.keys, platform)) {
        return { kind: "reserved", reason: reserved.reason };
      }
    }
  }
  for (const platform of PLATFORMS) {
    const bindings = current(platform);
    for (const other of shell.shortcuts) {
      if (other.id === id || !scopesMeet(other.scope, shortcut.scope)) continue;
      const otherKeys = bindings.get(other.id) ?? null;
      if (otherKeys !== null && keysClash(keys, otherKeys, platform)) {
        return { kind: "conflict", with: other.id };
      }
    }
  }
  return null;
}

/**
 * The stored bindings the registry still accepts. Each binding is checked against every other
 * shortcut's keys as they stand with all the stored bindings applied, so moving one shortcut frees its
 * keys for another; a binding for an unknown or fixed shortcut, or whose keys are now reserved or
 * clash, is dropped, and the shell never answers two shortcuts with one key.
 */
export function validBindings(
  registry: ShortcutRegistry,
  shellId: ShortcutShell,
  custom: CustomBindings,
): CustomBindings {
  const shell = registry.shells[shellId];
  const cache = new Map<Platform, ReadonlyMap<string, string | null>>();
  const current = (platform: Platform) => {
    let bindings = cache.get(platform);
    if (bindings === undefined) {
      bindings = effectiveBindings(shell, custom, platform);
      cache.set(platform, bindings);
    }
    return bindings;
  };
  const accepted: Record<string, string | null> = {};
  for (const [id, keys] of Object.entries(custom)) {
    const shortcut = shell.shortcuts.find((s) => s.id === id);
    if (!shortcut || shortcut.fixed) continue;
    if (keys === null || bindingProblem(registry, shellId, current, id, keys) === null) {
      accepted[id] = keys;
    }
  }
  return accepted;
}

/**
 * Every rule a registry breaks, for the loader and the tests: unique ids and go targets, known
 * scopes and groups, keys in the grammar, defaults that use no reserved keys (fixed shortcuts may use
 * the keys of keyboard operation, such as Escape and Enter, which they document), and no two defaults
 * that clash where their scopes meet, on either platform.
 */
export function registryProblems(registry: ShortcutRegistry): string[] {
  const problems: string[] = [];
  for (const reserved of registry.reserved) {
    const probe = reserved.keys.endsWith("+*") ? `${reserved.keys.slice(0, -1)}A` : reserved.keys;
    if (parseKeys(probe) === null)
      problems.push(`Reserved keys ${reserved.keys} are not in the grammar.`);
  }
  for (const shellId of SHORTCUT_SHELLS) {
    const shell = registry.shells[shellId];
    const where = (id: string) => `${shellId} shortcut ${id}`;
    if (!shell.scopes.includes(GLOBAL_SCOPE)) problems.push(`${shellId} has no global scope.`);
    const ids = new Set<string>();
    const targets = new Set<string>();
    const groups = new Set(shell.groups.map((g) => g.id));
    for (const s of shell.shortcuts) {
      if (ids.has(s.id)) problems.push(`${where(s.id)} is listed twice.`);
      ids.add(s.id);
      if (s.go !== null) {
        if (targets.has(s.go))
          problems.push(`${where(s.id)} opens ${s.go}, which another shortcut opens.`);
        targets.add(s.go);
      }
      if (!shell.scopes.includes(s.scope))
        problems.push(`${where(s.id)} names unknown scope ${s.scope}.`);
      if (!groups.has(s.group)) problems.push(`${where(s.id)} names unknown group ${s.group}.`);
      if (s.fixed && s.keys === null) problems.push(`${where(s.id)} is fixed but has no keys.`);
      for (const keys of [s.keys, s.mac]) {
        if (keys === null) continue;
        if (parseKeys(keys) === null) {
          problems.push(`${where(s.id)} keys ${keys} are not in the grammar.`);
          continue;
        }
        if (s.fields && !isModifierChord(keys)) {
          problems.push(
            `${where(s.id)} works in fields, so its keys ${keys} need Mod, Ctrl or Alt.`,
          );
        }
        for (const platform of PLATFORMS) {
          for (const reserved of registry.reserved) {
            if (reserved.platform !== null && reserved.platform !== platform) continue;
            if (s.fixed && reserved.reason === "navigation") continue;
            if (matchesReserved(keys, reserved.keys, platform)) {
              problems.push(`${where(s.id)} keys ${keys} are reserved (${reserved.reason}).`);
            }
          }
        }
      }
    }
    for (const platform of PLATFORMS) {
      const bindings = effectiveBindings(shell, {}, platform);
      shell.shortcuts.forEach((a, i) => {
        for (const b of shell.shortcuts.slice(i + 1)) {
          const ka = bindings.get(a.id) ?? null;
          const kb = bindings.get(b.id) ?? null;
          if (ka === null || kb === null || !scopesMeet(a.scope, b.scope)) continue;
          if (keysClash(ka, kb, platform)) {
            problems.push(
              `${shellId} shortcuts ${a.id} (${ka}) and ${b.id} (${kb}) conflict on ${platform}.`,
            );
          }
        }
      });
    }
  }
  return problems;
}
