import { isCharacterKey } from "@xos/schemas/shortcuts/keys";

/**
 * The showcaller console's keys (ADR 0131): which console action a chord pressed in the console makes,
 * from the shortcut registry's show scope with the person's own bindings. Pure, so the rule is tested
 * without a page: letters and symbols obey me.shortcuts_enabled, function keys F13 to F20 always answer
 * (WCAG 2.1.4 covers character keys only), and Space stays with RunOfShowLive so one press makes one call.
 */

export type ShowAction =
  "go" | "standby" | "previous" | "next" | "jump" | "nudge-later" | "nudge-earlier" | "department";

const ACTIONS: readonly ShowAction[] = [
  "go",
  "standby",
  "previous",
  "next",
  "jump",
  "nudge-later",
  "nudge-earlier",
  "department",
];

/** The console action a registry id names: show.next and show.deck.next are both Next. */
export function showActionOf(id: string): ShowAction | null {
  if (!id.startsWith("show.")) return null;
  const name = id.replace(/^show\.(?:deck\.)?/, "");
  return (ACTIONS as readonly string[]).includes(name) ? (name as ShowAction) : null;
}

/**
 * The action for a chord, or null when the console leaves the key alone. `scoped` is the person's
 * scoped keys by registry id (ShellKeys.scoped); `singleKeys` is me.shortcuts_enabled as applied.
 */
export function showKeyAction(
  chord: string,
  scoped: Readonly<Record<string, string>>,
  singleKeys: boolean,
): ShowAction | null {
  if (chord === "Space") return null;
  const id = Object.keys(scoped).find((k) => scoped[k] === chord && showActionOf(k) !== null);
  if (id === undefined) return null;
  if (isCharacterKey(chord) && !singleKeys) return null;
  return showActionOf(id);
}
