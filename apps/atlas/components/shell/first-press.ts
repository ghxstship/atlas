import type { ShellKeys } from "@/lib/shell/shell-keys";

/**
 * Holds the first key press of a page until the shell's key handler arrives (key-dispatch.ts), so a page nobody types
 * on never loads it (ADR 0027) and no press is lost. It waits at the same point the handler listens, after the page's
 * own components: a press one of them took stays theirs. The one thing that cannot wait is a browser's default for a
 * chord the shell binds (Mod+K), so that is stopped here, in a field only for the chords that work in fields.
 */
const CHORD = /^(?:Mod|Ctrl|Alt)\+/;

function inField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function bound(bindings: readonly string[], event: KeyboardEvent): boolean {
  const key = event.key.toUpperCase();
  return bindings.some((b) => {
    if (!CHORD.test(b)) return false;
    const parts = b.split("+");
    return parts.at(-1)?.toUpperCase() === key && parts.includes("Shift") === event.shiftKey;
  });
}

export function holdFirstPress(
  keys: () => ShellKeys | null,
  /** Called once, with the presses held so far: it installs the handler and answers them. */
  load: (held: readonly KeyboardEvent[]) => void,
): () => void {
  const held: KeyboardEvent[] = [];
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
    const now = keys();
    if (now !== null && (event.ctrlKey || event.metaKey || event.altKey)) {
      const usable = inField(event.target)
        ? now.fields.flatMap((id) => now.global[id] ?? [])
        : [...Object.values(now.global), ...Object.values(now.scoped)];
      if (bound(usable, event)) event.preventDefault();
    }
    held.push(event);
    if (held.length === 1) load(held);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
