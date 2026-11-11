"use client";

import { Button } from "@xos/ui";
import { singleKeyShortcutsEnabled } from "@xos/ui/preferences";
import { undoStack } from "@xos/ui/undo";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { ActionResult } from "@/lib/action-result";

/** One gesture and its visible, keyboard-operable equivalent. */
export interface SwipeAction {
  /** Button label, at most three words (Section 11.10). */
  readonly label: string;
  readonly action: () => Promise<ActionResult>;
  readonly icon?: string;
  /** Single key that runs the action while focus is inside the row, also announced as aria-keyshortcuts. */
  readonly shortcut: string;
  /** Status shown after it succeeds. */
  readonly done: string;
  /** True when the row leaves the list on success (pass, remove), offering Undo in its place. */
  readonly hides?: boolean;
  /** Undoes it (Section 11.10 rule: Undo instead of a confirmation). */
  readonly undo?: { readonly label: string; readonly action: () => Promise<ActionResult> };
}

/** Distance in CSS pixels a swipe must travel before it counts. */
const THRESHOLD = 80;
/** Farthest the row follows the finger. */
const MAX_DRAG = 120;

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Swipe actions for a list row on a touch screen (Section 11.10 habit 6, Section 11.12 Discover):
 * swipe right for the primary action (save) and left for the secondary one (pass, remove). Every
 * gesture has a visible button and a keyboard equivalent: the buttons sit under the row on every
 * screen, and the row's single-key shortcut runs the action while focus is inside it. The gesture
 * listens to touch pointers only, so a mouse still selects text and follows links. A row that leaves
 * the list (a pass) stays in place as one line with Undo until the next navigation, and goes on the
 * tab's undo stack (Section 11.7), so Cmd or Ctrl+Z undoes it too and Shift+Cmd or Ctrl+Z redoes it.
 */
export function SwipeActions({
  right,
  left,
  label,
  failed,
  children,
}: {
  right?: SwipeAction | undefined;
  left?: SwipeAction | undefined;
  /** Accessible name of the row's button group. */
  label: string;
  /** Message when an action fails. */
  failed: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dx, setDx] = useState(0);
  const [status, setStatus] = useState<{
    text: string;
    /** The undo stack entry of an action that can be undone, and its Undo label. */
    entry?: number;
    undoLabel?: string;
  } | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState(false);
  const origin = useRef<{ x: number; y: number; id: number } | null>(null);
  const dragged = useRef(false);
  const travel = useRef(0);
  const [touch, setTouch] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(pointer: coarse)");
    const update = () => setTouch(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  function run(item: SwipeAction | undefined) {
    if (!item || pending) return;
    setError(false);
    start(async () => {
      const result = await item.action();
      if (!result.ok) {
        setError(true);
        return;
      }
      if (item.hides) {
        setHidden(true);
        const undoItem = item.undo;
        if (!undoItem) {
          setStatus({ text: item.done });
          return;
        }
        // The row shows its own Undo in place, so the shell's toast stays out of the way.
        const entry = undoStack.push({
          label: item.done,
          toast: false,
          undo: async () => {
            const undone = await undoItem.action();
            if (!undone.ok) {
              setError(true);
              return { ok: false, message: failed };
            }
            setHidden(false);
            setStatus(null);
            router.refresh();
            return { ok: true };
          },
          redo: async () => {
            const redone = await item.action();
            if (!redone.ok) return { ok: false, message: failed };
            setHidden(true);
            setStatus({ text: item.done, entry: entry.id, undoLabel: undoItem.label });
            return { ok: true };
          },
        });
        setStatus({ text: item.done, entry: entry.id, undoLabel: undoItem.label });
      } else {
        setStatus({ text: item.done });
        router.refresh();
      }
    });
  }

  function undo(entry: number) {
    setError(false);
    start(async () => {
      await undoStack.undo(entry);
    });
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch" || pending) return;
    origin.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
    travel.current = 0;
    dragged.current = false;
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const o = origin.current;
    if (!o || o.id !== event.pointerId) return;
    const x = event.clientX - o.x;
    const y = event.clientY - o.y;
    if (!dragged.current && (Math.abs(x) < 12 || Math.abs(x) < Math.abs(y))) return;
    dragged.current = true;
    const allowed = (x > 0 && right) || (x < 0 && left) ? x : 0;
    travel.current = Math.max(-MAX_DRAG, Math.min(MAX_DRAG, allowed));
    setDx(travel.current);
  }

  function onPointerEnd() {
    // The ref, not the dx state: a fast swipe ends before React renders the last move, so the state
    // this handler closed over can still read 0.
    const travelled = travel.current;
    travel.current = 0;
    origin.current = null;
    setDx(0);
    if (travelled >= THRESHOLD) run(right);
    else if (travelled <= -THRESHOLD) run(left);
  }

  function onClickCapture(event: MouseEvent<HTMLDivElement>) {
    // A swipe that ends over the card's link is a swipe, not a tap on the link.
    if (dragged.current) {
      event.preventDefault();
      event.stopPropagation();
      dragged.current = false;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Single-key shortcuts follow the person's me.shortcuts_enabled (WCAG 2.1.4); the buttons always work.
    if (!singleKeyShortcutsEnabled()) return;
    if (event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return;
    const key = event.key.toLowerCase();
    if (right && key === right.shortcut) {
      event.preventDefault();
      run(right);
    } else if (left && key === left.shortcut) {
      event.preventDefault();
      run(left);
    }
  }

  if (hidden && status) {
    const { entry, undoLabel } = status;
    return (
      <div className="flex min-h-touch-min flex-wrap items-center gap-8 rounded-card border border-dashed border-border-subtle px-16 py-8 text-text-13 text-text-secondary">
        <span role="status">{status.text}</span>
        {entry !== undefined && undoLabel ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => undo(entry)}>
            {undoLabel}
          </Button>
        ) : null}
        {error ? (
          <span role="alert" className="text-danger-text">
            {failed}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-8" onKeyDown={onKeyDown}>
      <div className="relative h-full overflow-hidden rounded-card">
        {touch && (right || left) ? (
          <div
            aria-hidden="true"
            className="absolute inset-0 flex items-center justify-between rounded-card px-16 text-text-13 font-semibold"
          >
            <span className={dx > 0 ? "text-success-text" : "invisible"}>{right?.label}</span>
            <span className={dx < 0 ? "text-text-secondary" : "invisible"}>{left?.label}</span>
          </div>
        ) : null}
        <div
          className="relative h-full touch-pan-y bg-bg-base transition-transform duration-150 motion-reduce:transition-none"
          style={dx !== 0 ? { transform: `translateX(${dx}px)` } : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onClickCapture={onClickCapture}
        >
          {children}
        </div>
      </div>
      <div role="group" aria-label={label} className="flex flex-wrap items-center gap-8">
        {right ? (
          <Button
            size="sm"
            variant="secondary"
            {...(right.icon ? { icon: right.icon } : {})}
            disabled={pending}
            aria-keyshortcuts={right.shortcut.toUpperCase()}
            onClick={() => run(right)}
          >
            {right.label}
          </Button>
        ) : null}
        {left ? (
          <Button
            size="sm"
            variant="ghost"
            {...(left.icon ? { icon: left.icon } : {})}
            disabled={pending}
            aria-keyshortcuts={left.shortcut.toUpperCase()}
            onClick={() => run(left)}
          >
            {left.label}
          </Button>
        ) : null}
        {status ? (
          <span role="status" className="text-text-12 text-success-text">
            {status.text}
          </span>
        ) : null}
        {error ? (
          <span role="alert" className="text-text-12 text-danger-text">
            {failed}
          </span>
        ) : null}
      </div>
    </div>
  );
}
