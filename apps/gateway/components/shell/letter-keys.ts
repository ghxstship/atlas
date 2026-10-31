import { singleKeyShortcutsEnabled } from "@xos/ui/preferences";
import type { GatewayKeys } from "@/lib/shell/shell-keys";

/**
 * Gateway's letter shortcuts (Section 11.2): G then a letter goes to a destination, and single
 * letters run a shell command (the account panel, the organization switcher), from the registry
 * keys the server sent (lib/shell/shell-keys.ts). The frame installs it once.
 *
 * - Single keys obey me.shortcuts_enabled, read as the shell applies it to the document
 *   (singleKeyShortcutsEnabled, @xos/ui/preferences).
 * - They stay quiet while the person types in a field, inside dialogs and menus, and when a
 *   component already handled the key (preventDefault).
 * - G waits four seconds for its second key, as in Atlas; a key that completes no sequence cancels
 *   it and goes on to the page.
 */

export interface LetterState {
  readonly keys: GatewayKeys;
  /** Opens a page. */
  readonly go: (href: string) => void;
  /** Runs a shell command by shortcut id: `account` or `switch-org`. */
  readonly command: (id: string) => void;
}

/** How long G waits for the second key of a sequence, as in Atlas. */
export const PENDING_MS = 4000;
const OVERLAY =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]';
const FIELDS = ["INPUT", "TEXTAREA", "SELECT"];

/**
 * Listens for the letter shortcuts until the returned function is called. `state` holds the keys
 * and what they act on as of the latest render.
 */
export function installLetterKeys(state: { readonly current: LetterState }): () => void {
  let waiting: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onLetter = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const letter =
      /^[a-z]$/i.test(event.key) &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
        ? event.key.toUpperCase()
        : null;
    const quiet =
      event.defaultPrevented ||
      event.isComposing ||
      target?.isContentEditable === true ||
      FIELDS.includes(target?.tagName ?? "");
    const prefix = waiting;
    const now = state.current;
    if (prefix !== null) {
      clearTimeout(timer);
      waiting = null;
      const href = letter === null || quiet ? undefined : now.keys.go[`${prefix} ${letter}`];
      if (href !== undefined) {
        event.preventDefault();
        now.go(href);
      }
      return;
    }
    if (letter === null || quiet || event.repeat || !singleKeyShortcutsEnabled()) return;
    if (target instanceof Element && target.closest(OVERLAY)) return;
    const command = now.keys.commands[letter];
    if (Object.keys(now.keys.go).some((k) => k.startsWith(`${letter} `))) {
      event.preventDefault();
      waiting = letter;
      timer = setTimeout(() => {
        waiting = null;
      }, PENDING_MS);
    } else if (command !== undefined) {
      event.preventDefault();
      now.command(command);
    }
  };
  window.addEventListener("keydown", onLetter);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("keydown", onLetter);
  };
}
