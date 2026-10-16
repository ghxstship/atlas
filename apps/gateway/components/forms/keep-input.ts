"use client";

import { startTransition, type FormEvent } from "react";

/**
 * React resets a form's uncontrolled fields after a `<form action>` submission finishes, which
 * would wipe what a person typed when the server refuses the save. Submitting through onSubmit
 * keeps the input; `action` stays on the form so it still posts without JavaScript. Gateway forms
 * that succeed swap to a done state or clear themselves explicitly. Same pattern as Atlas
 * (components/collection-kit/keep-input.ts).
 */
export function keepInputOnSubmit(formAction: (data: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const data = new FormData(event.currentTarget, submitter);
    startTransition(() => formAction(data));
  };
}
