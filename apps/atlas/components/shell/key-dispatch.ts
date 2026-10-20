import { chordOf } from "@xos/schemas/shortcuts/keys";
import type { ShellKeys } from "@/lib/shell/shell-keys";

/**
 * The Atlas shell's key handler (Section 11.2 principle 1). The shell frame loads it, through
 * shell-keys.tsx, once the shell has hydrated, so it stays out of every route's first JavaScript
 * (ADR 0027). Every binding comes from the shortcut registry (packages/schemas/shortcuts.yaml) with
 * the person's own bindings applied on the server.
 *
 * - Keys never fire while the person types in a field, except shortcuts the registry marks `fields`
 *   (modifier chords such as Mod+K).
 * - Single keys (no Mod, Ctrl or Alt) obey me.shortcuts_enabled and stay quiet inside dialogs and
 *   menus, so they never act behind an open panel or clash with a screen reader's dialog keys.
 * - G, then a letter, goes to a section: the first key shows the hint, the next key either goes or
 *   cancels, Esc cancels, and the hint closes after four seconds.
 * - A key a component already handled (preventDefault) and keys pressed while composing text are
 *   left alone.
 */

export interface KeyHandlers {
  /** Runs a shell command by shortcut id: command-menu, search, create-menu, help, focus-mode, aurora. */
  readonly command: (id: string) => void;
  /** Opens a page. */
  readonly go: (href: string) => void;
  /** The first step of a sequence the person pressed, or null when no sequence is waiting. */
  readonly pending: (prefix: string | null) => void;
}

export interface KeyState {
  readonly keys: ShellKeys;
  readonly handlers: KeyHandlers;
}

const PENDING_MS = 4000;
const OVERLAY =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]';
const MODIFIER = /(?:^|\+)(?:Mod|Ctrl|Alt)\+/;

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

interface Table {
  readonly byKeys: ReadonlyMap<string, string>;
  readonly prefixes: ReadonlySet<string>;
}

function compile(keys: ShellKeys): Table {
  const byKeys = new Map<string, string>();
  const prefixes = new Set<string>();
  for (const [id, binding] of Object.entries(keys.global)) {
    byKeys.set(binding, id);
    const space = binding.indexOf(" ");
    if (space > 0) prefixes.add(binding.slice(0, space));
  }
  return { byKeys, prefixes };
}

/**
 * Listens for the shell's shortcuts until the returned function is called. `state` holds what the
 * keys act on as of the latest render; nothing answers while it is empty.
 */
export function installShellKeys(state: { readonly current: KeyState | null }): () => void {
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let compiled: { readonly from: ShellKeys; readonly table: Table } | null = null;

  const table = (keys: ShellKeys) => {
    if (compiled?.from !== keys) compiled = { from: keys, table: compile(keys) };
    return compiled.table;
  };
  const wait = (next: string | null) => {
    clearTimeout(timer);
    pending = next;
    state.current?.handlers.pending(next);
    if (next !== null) timer = setTimeout(() => wait(null), PENDING_MS);
  };
  const run = (event: KeyboardEvent, id: string, { keys, handlers }: KeyState) => {
    event.preventDefault();
    const target = keys.go[id];
    if (target) handlers.go(target.href);
    else handlers.command(id);
  };

  // The key after G is taken before any part of the page sees it, so G then H goes Home even while
  // focus is in a list whose own H acts on an item. A key that completes no sequence cancels it and
  // goes on to the page, but not to the shell's other shortcuts.
  let ended: KeyboardEvent | null = null;
  const onSequence = (event: KeyboardEvent) => {
    const now = state.current;
    if (pending === null || now === null || event.isComposing) return;
    const chord = chordOf(event, now.keys.platform);
    if (chord === null) return;
    const id = typing(event.target) ? undefined : table(now.keys).byKeys.get(`${pending} ${chord}`);
    wait(null);
    ended = event;
    if (id !== undefined) {
      event.stopPropagation();
      run(event, id, now);
    }
  };

  const onKey = (event: KeyboardEvent) => {
    const now = state.current;
    if (now === null || event === ended || event.defaultPrevented) return;
    if (event.isComposing || event.repeat) return;
    const { keys } = now;
    const chord = chordOf(event, keys.platform);
    if (chord === null) return;
    const { byKeys, prefixes } = table(keys);
    const single = !MODIFIER.test(chord);
    const id = byKeys.get(chord);
    if (typing(event.target)) {
      if (id !== undefined && !single && keys.fields.includes(id)) run(event, id, now);
      return;
    }
    if (single) {
      if (!keys.singleKeys) return;
      if (event.target instanceof Element && event.target.closest(OVERLAY)) return;
    }
    if (prefixes.has(chord)) {
      event.preventDefault();
      wait(chord);
    } else if (id !== undefined) {
      run(event, id, now);
    }
  };

  window.addEventListener("keydown", onSequence, true);
  window.addEventListener("keydown", onKey);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("keydown", onSequence, true);
    window.removeEventListener("keydown", onKey);
  };
}
