import { useContext, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Button } from "../Button/Button.tsx";
import { InToastRegion, toastClass } from "./Feedback.shared.tsx";
import { type UndoToastProps } from "./Feedback.types.ts";

/** Whether a key press lands in a text field, whose own undo keeps Cmd or Ctrl+Z. */
function inField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Replaces a confirmation for a reversible action: 8 seconds with a visible timer, Undo on the
 * button and on Cmd or Ctrl+Z. Shift+Cmd or Ctrl+Z is redo, not undo, and inside a text field the
 * keys stay the field's own.
 */
export function UndoToast({
  message,
  seconds = 8,
  onUndo,
  onExpire,
}: UndoToastProps): ReactElement {
  const t = useT();
  const inRegion = useContext(InToastRegion);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done) return undefined;
    const timer = setTimeout(() => {
      setDone(true);
      onExpire?.();
    }, seconds * 1000);
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "z" &&
        !inField(e.target)
      ) {
        e.preventDefault();
        setDone(true);
        onUndo?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKey);
    };
  }, [done, seconds, onUndo, onExpire]);
  return (
    <div className={toastClass} {...(inRegion ? {} : { role: "status" })}>
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
        {t("action.undo")}
      </Button>
      <span
        aria-hidden="true"
        className="xos-anim-drain absolute start-0 bottom-0 h-(--stroke-width-focus) w-full bg-accent"
        style={{ "--xos-seconds": seconds } as CSSProperties}
      />
    </div>
  );
}
