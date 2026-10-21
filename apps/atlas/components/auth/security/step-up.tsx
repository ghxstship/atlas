"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Step-up (Section 9, A77): an action the database refuses with `step_up_required` opens this dialog, which asks
 * for a second factor (or sets one up when the person has none) and then resumes the action. The dialog's code
 * loads only when it first opens.
 */
const StepUpDialog = dynamic(() => import("./step-up-dialog").then((m) => m.StepUpDialog));

export interface StepUp {
  /** Opens the dialog; `resume` runs once the person has verified. */
  readonly request: (resume: () => void) => void;
  /** Render this where the dialog belongs. */
  readonly dialog: ReactNode;
}

export function useStepUp(): StepUp {
  const [open, setOpen] = useState(false);
  const resume = useRef<(() => void) | null>(null);
  const request = useCallback((next: () => void) => {
    resume.current = next;
    setOpen(true);
  }, []);
  const dialog = open ? (
    <StepUpDialog
      onCancel={() => setOpen(false)}
      onVerified={() => {
        setOpen(false);
        const next = resume.current;
        resume.current = null;
        next?.();
      }}
    />
  ) : null;
  return { request, dialog };
}

/**
 * For a form whose action state can carry the `step_up_required` refusal: each new refusing state opens the
 * dialog, and verifying submits `form` again. Returns the dialog, to render outside the form (React bubbles a
 * portal's submit event to its tree parents).
 */
export function useStepUpForm<S>(
  state: S,
  refused: (state: S) => boolean,
  form: React.RefObject<HTMLFormElement | null>,
): ReactNode {
  const { request, dialog } = useStepUp();
  const seen = useRef(state);
  useEffect(() => {
    if (state === seen.current) return;
    seen.current = state;
    if (refused(state)) request(() => form.current?.requestSubmit());
  }, [state, refused, request, form]);
  return dialog;
}
