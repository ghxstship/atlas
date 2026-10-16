"use client";

import { startTransition, useEffect, useRef, type FormEvent } from "react";

/**
 * React resets a form's uncontrolled fields after a `<form action>` submission finishes, which
 * would wipe what a person typed when the server refuses the save. Submitting through onSubmit
 * keeps the input; `action` stays on the form so it still posts without JavaScript.
 */
export function keepInputOnSubmit(formAction: (data: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const data = new FormData(event.currentTarget, submitter);
    startTransition(() => formAction(data));
  };
}

/** Clears the form once a save succeeds, as React would have done, so the next entry starts fresh. */
export function useResetOnSuccess(state: { readonly ok?: boolean }) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);
  return form;
}

/**
 * Both halves for one form: `onSubmit` keeps typed input when the save is refused, and `ref`
 * clears the form after a new state that `succeeded` accepts (each state object is judged once).
 * Spread onto the form next to `action`: `<form action={dispatch} {...keep}>`.
 */
export function useKeepInput<S>(
  state: S,
  formAction: (data: FormData) => void,
  succeeded: (state: S) => boolean,
) {
  const ref = useRef<HTMLFormElement>(null);
  const seen = useRef(state);
  useEffect(() => {
    // A new `succeeded` function each render reruns this, but each state is judged only once.
    if (state === seen.current) return;
    seen.current = state;
    if (succeeded(state)) ref.current?.reset();
  }, [state, succeeded]);
  return { ref, onSubmit: keepInputOnSubmit(formAction) };
}
