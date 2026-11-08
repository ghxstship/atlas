"use client";

import { AGE_OLD_ENOUGH, AGE_UNDER } from "@xos/data/consent";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState, type KeyboardEvent, type ReactNode } from "react";
import {
  acceptInvitation,
  answerAgeQuestion,
  closeUnderAgeAccount,
  signInWithEmail,
  signUpWithEmail,
  type FormState,
} from "@/app/auth/actions";
import { Button, InlineAlert, Input } from "@xos/ui";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
/** Auth forms (Auth template). Each keeps typed input after a failed submit (Section 11.7). */

type Translate = (key: string, values?: Record<string, string>) => string;

export function useAuthCopy(): Translate {
  const t = useTranslations("shell.auth");
  return (key, values) => (t as unknown as Translate)(key, values);
}

/** The message for a form state error key: refusals from invites, everything else from errors. */
export function errorMessage(
  t: Translate,
  key: string,
  values?: Readonly<Record<string, string>>,
): string {
  return key.startsWith("invite.")
    ? t(`invite.refused.${key.slice("invite.".length)}`)
    : t(`errors.${key}`, values ? { ...values } : undefined);
}

/** The field's error message, or an empty string (no error shown). */
export function fieldError(t: Translate, state: FormState, field: string): string {
  const key = state.fieldErrors?.[field];
  return key === undefined ? "" : t(`errors.${key}`);
}

export const INITIAL: FormState = {};

/**
 * The age question (Section 14.3, 14.9; Terms of Service 3.2): both answers with equal weight, and no rule stated until
 * it is answered (ADR 0156). Every way of creating or first using an account asks it; the action records it
 * (migrations 1381 and 6840), and an answer of under 18 ends there.
 */
export function AgeConfirmation({ id, state }: { id: string; state: FormState }) {
  const t = useAuthCopy();
  const error = state.fieldErrors?.["ageConfirmed"];
  const answer = state.values?.["ageConfirmed"];
  const describedBy = error ? `${id}-error` : undefined;
  return (
    <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
      <legend className="mb-8 text-text-13 font-medium">{t("fields.ageLegend")}</legend>
      <label
        htmlFor={id}
        className="xos-check inline-flex cursor-pointer items-center gap-8 text-text-13"
      >
        <input
          id={id}
          type="radio"
          name="ageConfirmed"
          value={AGE_OLD_ENOUGH}
          required
          defaultChecked={answer === AGE_OLD_ENOUGH}
          aria-describedby={describedBy}
          className="xos-check-input"
        />
        <span>{t("fields.age")}</span>
      </label>
      <label
        htmlFor={`${id}-under`}
        className="xos-check inline-flex cursor-pointer items-center gap-8 text-text-13"
      >
        <input
          id={`${id}-under`}
          type="radio"
          name="ageConfirmed"
          value={AGE_UNDER}
          required
          defaultChecked={answer === AGE_UNDER}
          aria-describedby={describedBy}
          className="xos-check-input"
        />
        <span>{t("fields.ageUnder")}</span>
      </label>
      {error ? (
        <p id={`${id}-error`} className="m-0 text-text-12 text-danger-text">
          {t("errors.age")}
        </p>
      ) : null}
    </fieldset>
  );
}

export function Submit({
  pending,
  children,
  method,
  variant = "primary",
}: {
  pending: boolean;
  children: ReactNode;
  /** For a form with two submit buttons: which way this one submits (`method` in the form data). */
  method?: string;
  variant?: "primary" | "secondary";
}) {
  return (
    <Button
      type="submit"
      variant={variant}
      {...(method ? { name: "method", value: method } : {})}
      disabled={pending}
      aria-busy={pending}
      className="w-full"
    >
      {children}
    </Button>
  );
}

/** The "or" rule between the link action and the password, inside one form. */
function OrRule() {
  const t = useAuthCopy();
  return (
    <div className="flex items-center gap-8 text-text-12 text-text-tertiary" role="separator">
      <span className="h-px flex-1 bg-border-subtle" />
      {t("or")}
      <span className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}

/**
 * Enter in the password field submits with the password, not with the form's first button (the
 * email link), so typing a password and pressing Enter signs in as expected.
 */
function submitWithPassword(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key !== "Enter") return;
  const form = event.currentTarget.form;
  const button = form?.querySelector<HTMLButtonElement>('button[name="method"][value="password"]');
  if (!form || !button) return;
  event.preventDefault();
  form.requestSubmit(button);
}

/**
 * Sign in (A59-025, Section 11.10 rules 6 and 12): one Email field with two actions. The email link
 * is the one primary action; the password below it signs in with the secondary button.
 */
export function SignInForm({ next }: { next: string }) {
  const t = useAuthCopy();
  const [state, action, pending] = useActionState(signInWithEmail, INITIAL);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      {state.error ? <InlineAlert tone="danger">{errorMessage(t, state.error)}</InlineAlert> : null}
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="intent" value="sign-in" />
      <Input
        width="100%"
        id="signin-email"
        name="email"
        type="email"
        autoComplete="email"
        required
        label={t("fields.email")}
        defaultValue={state.values?.["email"] ?? ""}
        error={fieldError(t, state, "email")}
      />
      <Submit pending={pending} method="link">
        {t("signIn.magicLink")}
      </Submit>
      <OrRule />
      <Input
        width="100%"
        id="signin-password"
        name="password"
        type="password"
        autoComplete="current-password"
        label={t("fields.password")}
        error={fieldError(t, state, "password")}
        onKeyDown={submitWithPassword}
      />
      <Submit pending={pending} method="password" variant="secondary">
        {t("signIn.password")}
      </Submit>
    </form>
  );
}

/**
 * Create an account (A59-025): the full name and one Email field, then the email link as the one
 * primary action, or a password with the secondary "Create account".
 */
export function SignUpForm({ next }: { next: string }) {
  const t = useAuthCopy();
  const [state, action, pending] = useActionState(signUpWithEmail, INITIAL);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      {state.error ? <InlineAlert tone="danger">{errorMessage(t, state.error)}</InlineAlert> : null}
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="intent" value="sign-up" />
      <Input
        width="100%"
        id="signup-name"
        name="fullName"
        autoComplete="name"
        required
        label={t("fields.fullName")}
        defaultValue={state.values?.["fullName"] ?? ""}
        error={fieldError(t, state, "fullName")}
      />
      <Input
        width="100%"
        id="signup-email"
        name="email"
        type="email"
        autoComplete="email"
        required
        label={t("fields.email")}
        defaultValue={state.values?.["email"] ?? ""}
        error={fieldError(t, state, "email")}
      />
      <AgeConfirmation id="signup-age" state={state} />
      <Submit pending={pending} method="link">
        {t("signUp.magicLink")}
      </Submit>
      <OrRule />
      <Input
        width="100%"
        id="signup-password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={12}
        label={t("fields.password")}
        help={t("fields.passwordHelp")}
        error={fieldError(t, state, "password")}
        onKeyDown={submitWithPassword}
      />
      <Submit pending={pending} method="password" variant="secondary">
        {t("signUp.submit")}
      </Submit>
    </form>
  );
}

/** The age question on its own, for anyone who has not answered at 18 (/auth/age). */
export function AgeQuestionForm({ next }: { next: string }) {
  const t = useAuthCopy();
  const [state, action, pending] = useActionState(answerAgeQuestion, INITIAL);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      {state.error ? <InlineAlert tone="danger">{errorMessage(t, state.error)}</InlineAlert> : null}
      <input type="hidden" name="next" value={next} />
      <AgeConfirmation id="age-question" state={state} />
      <Submit pending={pending}>{t("ageQuestion.submit")}</Submit>
    </form>
  );
}

/**
 * What an answer of under 18 does to an existing account, before it does it: closing cannot be undone, so an adult who
 * chose the wrong answer gets to go back (ADR 0156). No field: the page's whole question is this one button.
 */
export function AgeUnderConfirmForm({ back }: { back: string }) {
  const t = useAuthCopy();
  const [state, action, pending] = useActionState(closeUnderAgeAccount, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-12" noValidate>
      {state.error ? <InlineAlert tone="danger">{errorMessage(t, state.error)}</InlineAlert> : null}
      <Button type="submit" variant="danger" loading={pending} className="w-full">
        {t("ageQuestion.under.confirm")}
      </Button>
      <Link
        href={`/auth/age?next=${encodeURIComponent(back)}` as Route}
        className="text-center text-text-13 text-accent-text underline"
      >
        {t("ageQuestion.under.back")}
      </Link>
    </form>
  );
}

export function AcceptInviteForm({ token, askAge = false }: { token: string; askAge?: boolean }) {
  const t = useAuthCopy();
  const [state, action, pending] = useActionState(acceptInvitation, INITIAL);
  return (
    <form action={action} onSubmit={keepInputOnSubmit(action)} className="flex flex-col gap-12">
      {state.error ? <InlineAlert tone="danger">{errorMessage(t, state.error)}</InlineAlert> : null}
      <input type="hidden" name="token" value={token} />
      {askAge ? <AgeConfirmation id="invite-age" state={state} /> : null}
      <Submit pending={pending}>{t("invite.accept")}</Submit>
    </form>
  );
}
