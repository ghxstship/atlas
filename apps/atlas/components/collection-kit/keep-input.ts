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
