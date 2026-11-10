import {
  displayKeys,
  effectiveBindings,
  GLOBAL_SCOPE,
  normalizeKeys,
  validBindings,
  type CustomBindings,
  type Platform,
  type ShortcutRegistry,
} from "@xos/schemas/shortcuts";

/**
 * The Atlas shell's keyboard model for one person (Section 3.15, Section 11.2): every shortcut's keys
 * from the registry (packages/schemas/shortcuts.yaml) with the person's own bindings applied, already
 * normalized and written for their platform. The server builds it, so the browser ships neither the
 * registry nor key parsing until the shell's key handler loads. Client components import the type only.
 */
export interface ShellKeys {
  readonly platform: Platform;
  /** Keys of the shortcuts the shell's key handler answers anywhere, by registry id. */
  readonly global: Readonly<Record<string, string>>;
  /** Keys of shortcuts that answer in one region of a page (Inbox items, a record), by registry id. */
  readonly scoped: Readonly<Record<string, string>>;
  /** The region each scoped shortcut answers in (`record`, `view`, `inbox`, `list`), by registry id. */
  readonly scopes: Readonly<Record<string, string>>;
  /** Global shortcuts that also work while typing in a field. */
  readonly fields: readonly string[];
  /** Where each navigation shortcut the person may use goes, by registry id. */
  readonly go: Readonly<Record<string, GoTarget>>;
  /** Every bound shortcut's keys as people read them on the platform (`⌘ K`, `G H`), by id. */
  readonly display: Readonly<Record<string, string>>;
}

export interface GoTarget {
  /** The sitemap node the shortcut opens. */
  readonly node: string;
  readonly href: string;
  readonly label: string;
}

/**
 * Builds the shell keys for a person. `custom` is what they stored (app.shortcut_bindings), of which a
 * binding the registry would now refuse is left out; `goTargets` holds the sitemap nodes the person
 * may open, and a navigation shortcut whose node is missing is left out with it.
 */
export function buildShellKeys(
  registry: ShortcutRegistry,
  input: {
    readonly platform: Platform;
    readonly custom: CustomBindings;
    readonly goTargets: ReadonlyMap<string, Omit<GoTarget, "node">>;
  },
): ShellKeys {
  const { platform } = input;
  const shell = registry.shells.atlas;
  const bindings = effectiveBindings(
    shell,
    validBindings(registry, "atlas", input.custom),
    platform,
  );
  const global: Record<string, string> = {};
  const scoped: Record<string, string> = {};
  const scopes: Record<string, string> = {};
  const display: Record<string, string> = {};
  const go: Record<string, GoTarget> = {};
  const fields: string[] = [];
  for (const shortcut of shell.shortcuts) {
    const keys = bindings.get(shortcut.id) ?? null;
    const normalized = keys === null ? null : normalizeKeys(keys, platform);
    if (normalized === null) continue;
    if (shortcut.go !== null) {
      const target = input.goTargets.get(shortcut.go);
      if (!target) continue;
      go[shortcut.id] = { node: shortcut.go, ...target };
    }
    display[shortcut.id] = displayKeys(normalized, platform);
    if (shortcut.scope !== GLOBAL_SCOPE) {
      scoped[shortcut.id] = normalized;
      scopes[shortcut.id] = shortcut.scope;
    } else if (!shortcut.fixed) {
      // Escape belongs to every dialog and menu: the sheet lists it, the shell never answers it.
      global[shortcut.id] = normalized;
      if (shortcut.fields) fields.push(shortcut.id);
    }
  }
  return { platform, global, scoped, scopes, fields, go, display };
}

/** Command menu hints: each navigation shortcut's keys by the sitemap node it opens. */
export function goHints(keys: ShellKeys): Record<string, string> {
  return Object.fromEntries(
    Object.entries(keys.go).flatMap(([id, target]) => {
      const shown = keys.display[id];
      return shown ? [[target.node, shown]] : [];
    }),
  );
}
