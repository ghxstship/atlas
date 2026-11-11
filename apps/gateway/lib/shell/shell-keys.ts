import type { ShortcutRegistry } from "@xos/schemas/shortcuts";

/**
 * Gateway's keyboard model for one person (Section 3.15, Section 4.5.8), built on the server from the
 * shortcut registry (packages/schemas/shortcuts.yaml) so the browser ships neither the registry nor key
 * parsing with every page. The frame answers the letter shortcuts from it: G then a letter for the
 * destinations the person may open, and the account and organization switcher keys. Search (Mod+K),
 * help (`?`) and Esc are the frame's own (gateway-frame.tsx), and the test holds them to the registry.
 */
export interface GatewayKeys {
  /** Where each sequence goes, by its keys (`G H`). */
  readonly go: Readonly<Record<string, string>>;
  /** Shell commands by their key (`A`): `account`, `switch-org`. */
  readonly commands: Readonly<Record<string, string>>;
  /** Registry ids the help panel lists for the person, in registry order. */
  readonly shown: readonly string[];
}

const LETTER = /^[A-Z]$/;
const SEQUENCE = /^[A-Z] [A-Z]$/;

/**
 * Builds the keys for a person. `hrefs` holds the destinations they may open by sitemap node; a
 * navigation shortcut whose node is missing is left out. `commands` names the shell commands the
 * page offers (switch-org only on the platform address).
 */
export function buildGatewayKeys(
  registry: ShortcutRegistry,
  hrefs: ReadonlyMap<string, string>,
  commands: ReadonlySet<string>,
): GatewayKeys {
  const go: Record<string, string> = {};
  const byKey: Record<string, string> = {};
  const shown: string[] = [];
  for (const shortcut of registry.shells.gateway.shortcuts) {
    const keys = shortcut.keys;
    if (keys === null) continue;
    if (shortcut.go !== null) {
      const href = hrefs.get(shortcut.go);
      if (href === undefined || !SEQUENCE.test(keys)) continue;
      go[keys] = href;
    } else if (LETTER.test(keys)) {
      if (!commands.has(shortcut.id)) continue;
      byKey[keys] = shortcut.id;
    }
    shown.push(shortcut.id);
  }
  return { go, commands: byKey, shown };
}
