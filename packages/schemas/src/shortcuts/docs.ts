import { SHORTCUT_SHELLS, type ShortcutRegistry, type ShortcutShell } from "./model.ts";

/**
 * Shortcut lists for the help articles (Section 3.15: the docs read the registry). An article holds a
 * generated list between `<!-- shortcuts <shell> <group> -->` and `<!-- /shortcuts -->`, and each
 * shell's help generator fills it from the registry in the article's locale, so the keys the articles
 * name are the registry defaults by construction. Build-time only; no app bundle imports this file.
 */

/** A message catalog as nested objects (getMessages from @xos/i18n). */
export type Catalog = unknown;

function lookup(catalog: Catalog, key: string): string | undefined {
  const value = key
    .split(".")
    .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], catalog);
  return typeof value === "string" ? value : undefined;
}

/**
 * Default keys as an article writes them: the registry form (`Mod+K`, `G H`), with named keys in the
 * locale's words (`help.shortcuts.keyNames`, such as Esc for Escape).
 */
export function articleKeys(keys: string, catalog: Catalog): string {
  return keys
    .split(" ")
    .map((chord) =>
      chord
        .split("+")
        .map((part) => lookup(catalog, `help.shortcuts.keyNames.${part}`) ?? part)
        .join("+"),
    )
    .join(" ");
}

/**
 * The lines of one shell group's shortcut list (`- **G H**: Go to Home`): every shortcut of the
 * group with default keys, in registry order, labeled from the catalog. A macOS default that differs
 * follows after a slash. Throws on a label the catalog lacks, so a list never ships a raw key.
 */
export function shortcutList(
  registry: ShortcutRegistry,
  shell: ShortcutShell,
  group: string,
  catalog: Catalog,
): string[] {
  return registry.shells[shell].shortcuts.flatMap((s) => {
    if (s.group !== group || s.keys === null) return [];
    const label = lookup(catalog, s.label);
    if (label === undefined) throw new Error(`No copy for ${s.label}.`);
    const keys = [s.keys, ...(s.mac === null ? [] : [s.mac])]
      .map((k) => `**${articleKeys(k, catalog)}**`)
      .join(" / ");
    return [`- ${keys}: ${label}`];
  });
}

/**
 * The help partial renderer for `shortcuts <shell> <group>` (fillPartials in @xos/help/node): the
 * group's list in the article's locale, or null for any other partial or an unknown shell or group.
 */
export function shortcutPartial(
  registry: ShortcutRegistry,
  catalogFor: (locale: string) => Catalog,
): (name: string, args: readonly string[], locale: string) => string[] | null {
  return (name, args, locale) => {
    const [shell, group, ...rest] = args;
    if (name !== "shortcuts" || rest.length > 0) return null;
    if (!(SHORTCUT_SHELLS as readonly string[]).includes(shell ?? "")) return null;
    const shellId = shell as ShortcutShell;
    if (!registry.shells[shellId].groups.some((g) => g.id === group)) return null;
    return shortcutList(registry, shellId, group as string, catalogFor(locale));
  };
}
