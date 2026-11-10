import {
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { useT } from "../lib/context.tsx";
import { Button } from "../Button/Button.tsx";
import { InToastRegion, toastClass } from "./Feedback.shared.tsx";
import { type UndoToastProps } from "./Feedback.types.ts";

/**
 * Replaces a confirmation for a reversible action: 8 seconds with a visible timer, Undo on the
 * button and on Cmd or Ctrl+Z. Shift+Cmd or Ctrl+Z is redo, not undo, and inside a text field the
 * keys stay the field's own. The timer pauses while the pointer is over the toast or focus is in it
 * (WCAG 2.2.1, Timing Adjustable), and resumes with the time that was left.
 */
export function UndoToast({
  message,
  seconds = 8,
  onUndo,
  onExpire,
  undoLabel,
}: UndoToastProps): ReactElement {
  const t = useT();
  const inRegion = useContext(InToastRegion);
  const [done, setDone] = useState(false);
  const [paused, setPaused] = useState(false);
  // Milliseconds still left on the timer, kept across pauses.
  const left = useRef(seconds * 1000);
  useEffect(() => {
    if (done || paused) return undefined;
    const started = Date.now();
    const timer = setTimeout(() => {
      setDone(true);
      onExpire?.();
    }, left.current);
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "z" &&
        // In a text field (anything editable: :read-write) the keys stay the field's own undo.
        !(e.target as Element).matches?.(":read-write")
      ) {
        e.preventDefault();
        setDone(true);
        onUndo?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(0, left.current - (Date.now() - started));
      document.removeEventListener("keydown", onKey);
    };
  }, [done, paused, onUndo, onExpire]);
  return (
    <div
      className={toastClass}
      {...(inRegion ? {} : { role: "status" })}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      <span>{message}</span>
      <Button
        size="sm"
        variant="ghost"
        icon="Undo2"
        shortcut="⌘Z"
        disabled={done}
        onClick={() => {
          setDone(true);
          onUndo?.();
        }}
      >
        {undoLabel ?? t("action.undo")}
      </Button>
      <span
        aria-hidden="true"
        className="xos-anim-drain absolute start-0 bottom-0 h-(--stroke-width-focus) w-full bg-accent"
        style={
          {
            "--xos-seconds": seconds,
            animationPlayState: paused ? "paused" : "running",
          } as CSSProperties
        }
      />
    </div>
  );
}
