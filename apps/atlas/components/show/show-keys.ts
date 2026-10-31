import { isCharacterKey, type Platform } from "@xos/schemas/shortcuts/keys";

/**
 * The showcaller console's keys (ADR 0131): which console action a chord pressed in the console makes,
 * from the shortcut registry's show scope with the person's own bindings. Pure, so the rule is tested
 * without a page: letters and symbols obey me.shortcuts_enabled, function keys F13 to F20 always answer
 * (WCAG 2.1.4 covers character keys only), and Space stays with RunOfShowLive so one press makes one call.
 */

export type ShowAction =
  | "go"
  | "standby"
  | "previous"
  | "next"
  | "jump"
  | "nudge-later"
  | "nudge-earlier"
  | "department"
  | "chat";

const ACTIONS: readonly ShowAction[] = [
  "go",
  "standby",
  "previous",
  "next",
  "jump",
  "nudge-later",
  "nudge-earlier",
  "department",
  // show.chat: the console hands focus to the show channel's message box beside it (B3, ADR 0142).
  "chat",
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

/**
 * The cue Previous or Next puts on standby, as an index into the position-ordered cues, or undefined when there is
 * none that way. They move from the picked cue, else the standby cue, else the current cue, so with nothing on
 * standby the first Next stands by the next cue rather than the one after it; called cues are passed over and
 * skipped ones are not.
 */
export function stepTarget(
  cues: readonly { readonly calledAt: string | null }[],
  at: {
    readonly picked: number;
    readonly current: number;
    readonly next: number;
    readonly standby: boolean;
  },
  direction: -1 | 1,
): number | undefined {
  const from = at.picked >= 0 ? at.picked : at.standby ? at.next : at.current;
  const uncalled = cues.flatMap((c, i) => (c.calledAt === null ? [i] : []));
  return direction === 1
    ? uncalled.find((i) => i > from)
    : [...uncalled].reverse().find((i) => i < from);
}

/**
 * The show scope's default keys by registry id, for the showcaller portal (B3, ADR 0142), which runs outside the
 * Atlas shell and so has no person whose bindings to read. The registry is the source, as in the shell.
 */
export function defaultShowKeys(
  shell: {
    readonly shortcuts: readonly {
      readonly id: string;
      readonly scope: string;
      readonly keys: string | null;
      readonly mac: string | null;
    }[];
  },
  platform: Platform,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const shortcut of shell.shortcuts) {
    if (shortcut.scope !== "show") continue;
    const keys = platform === "mac" && shortcut.mac !== null ? shortcut.mac : shortcut.keys;
    if (keys !== null) out[shortcut.id] = keys;
  }
  return out;
}
