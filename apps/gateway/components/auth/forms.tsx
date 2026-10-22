"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState, type ReactNode } from "react";
import {
  acceptSignUpTerms,
  sendMagicLink,
  signInWithPassword,
  signUp,
  type FormState,
} from "@/app/auth/actions";
import { Button, Checkbox, InlineAlert, Input } from "@xos/ui";

import { keepInputOnSubmit } from "@/components/forms/keep-input";

/**
 * Auth forms (Auth template). Each card has one Email field and one primary action: the sign-in
 * link first, a password on request (Section 11.10, rule 12; finding A59-025, which found a second
 * Email field for the password). The Email field stays mounted when the method changes, so what was
 * typed carries over, and every form keeps typed input after a failed submit (Section 11.7).
 */

type Translate = (key: string, values?: Record<string, string>) => string;

export type AuthMethod = "link" | "password";

function useAuthCopy(): Translate {
  const t = useTranslations("gateway.auth");
  return (key, values) => (t as unknown as Translate)(key, values);
}

/** The message for a form state error key. */
export function errorMessage(t: Translate, key: string): string {
  return t(`errors.${key}`);
}

/** The field's error message, or an empty string (no error shown). */
function fieldError(t: Translate, state: FormState, field: string): string {
  const key = state.fieldErrors?.[field];
  return key === undefined ? "" : t(`errors.${key}`);
}

const INITIAL: FormState = {};

function Submit({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <Button
      type="submit"
      variant="primary"
      disabled={pending}
      aria-busy={pending}
      className="w-full"
    >
      {children}
    </Button>
  );
}

/** Switches between the sign-in link and a password; not a submit, so Enter keeps the primary. */
function MethodSwitch({ label, onSwitch }: { label: string; onSwitch: () => void }) {
  return (
    <button
      type="button"
      onClick={onSwitch}
      className="inline-flex min-h-touch-min items-center self-start text-text-13 font-medium text-accent-text underline"
    >
      {label}
    </button>
  );
}

/** One method at a time, with the action state of each and focus moved to the password field. */
function useMethod(initial: AuthMethod, passwordId: string) {
  const [method, setMethod] = useState<AuthMethod>(initial);
  const [switched, setSwitched] = useState(false);
  useEffect(() => {
    if (switched && method === "password") document.getElementById(passwordId)?.focus();
  }, [method, switched, passwordId]);
  return {
    method,
    toggle: () => {
      setSwitched(true);
      setMethod((m) => (m === "link" ? "password" : "link"));
    },
  };
}

/** Sign in: Email, then the link (primary) or, on request, a password. */
export function SignInForm({ next, initial = "link" }: { next: string; initial?: AuthMethod }) {
  const t = useAuthCopy();
  const { method, toggle } = useMethod(initial, "signin-password");
  const [linkState, linkAction, linkPending] = useActionState(sendMagicLink, INITIAL);
  const [passwordState, passwordAction, passwordPending] = useActionState(
    signInWithPassword,
    INITIAL,
  );
  const password = method === "password";
  const state = password ? passwordState : linkState;
  const action = password ? passwordAction : linkAction;
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
      {password ? (
        <Input
          width="100%"
          id="signin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          label={t("fields.password")}
          error={fieldError(t, state, "password")}
        />
      ) : null}
      <Submit pending={password ? passwordPending : linkPending}>
        {t(password ? "signIn.password" : "signIn.magicLink")}
      </Submit>
      <MethodSwitch label={t(password ? "useLink" : "usePassword")} onSwitch={toggle} />
    </form>
  );
}

/**
 * "I am 16 or older" (Section 14.3, 14.9; Terms of Service 3.2), asked wherever an account is
 * created or first used; the action records it (migration 1381).
 */
function AgeConfirmation({ id, state }: { id: string; state: FormState }) {
  const t = useAuthCopy();
  const error = state.fieldErrors?.["ageConfirmed"];
  return (
    <div className="flex flex-col gap-4">
      <Checkbox
        id={id}
        name="ageConfirmed"
        value="16"
        required
        defaultChecked={state.values?.["ageConfirmed"] === "16"}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        label={<span className="text-text-13">{t("fields.age")}</span>}
      />
      {error ? (
        <p id={`${id}-error`} className="m-0 text-text-13 text-danger-text">
          {t("errors.age")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Create an account: name, Email, the Worker Terms (accepted) and the Privacy Policy (read), then
 * the link (primary) or, on request, a password. Nothing is created until the terms box is ticked.
 */
export function SignUpForm({
  next,
  termsLabel,
  initial = "link",
}: {
  next: string;
  termsLabel: ReactNode;
  initial?: AuthMethod;
}) {
  const t = useAuthCopy();
  const { method, toggle } = useMethod(initial, "signup-password");
  const [linkState, linkAction, linkPending] = useActionState(sendMagicLink, INITIAL);
  const [passwordState, passwordAction, passwordPending] = useActionState(signUp, INITIAL);
  const password = method === "password";
  const state = password ? passwordState : linkState;
  const action = password ? passwordAction : linkAction;
  const termsError = fieldError(t, state, "acceptTerms");
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
      {password ? (
        <Input
          width="100%"
          id="signup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          label={t("fields.password")}
          help={t("fields.passwordHelp")}
          error={fieldError(t, state, "password")}
        />
      ) : null}
      <div className="flex flex-col gap-4">
        <Checkbox
          id="signup-terms"
          name="acceptTerms"
          value="yes"
          required
          defaultChecked={state.values?.["acceptTerms"] === "yes"}
          aria-invalid={termsError ? true : undefined}
          aria-describedby={termsError ? "signup-terms-error" : undefined}
          label={<span className="text-text-13">{termsLabel}</span>}
        />
        {termsError ? (
          <p id="signup-terms-error" className="m-0 text-text-13 text-danger-text">
            {termsError}
          </p>
        ) : null}
      </div>
      <AgeConfirmation id="signup-age" state={state} />
      <Submit pending={password ? passwordPending : linkPending}>
        {t(password ? "signUp.submit" : "signIn.magicLink")}
      </Submit>
      <MethodSwitch label={t(password ? "useLink" : "usePassword")} onSwitch={toggle} />
    </form>
  );
}

/**
 * The Worker Terms for an account a provider created (ADR 0036): the same box as on the sign-up
 * form, then on to where the person was going.
 */
export function TermsForm({
  next,
  termsLabel,
  askAge = true,
}: {
  next: string;
  termsLabel: ReactNode;
  /** The person has not confirmed they are 16 or older yet. */
  askAge?: boolean;
}) {
  const t = useAuthCopy();
  const [state, action, pending] = useActionState(acceptSignUpTerms, INITIAL);
  const termsError = fieldError(t, state, "acceptTerms");
  return (
    <form action={action} className="flex flex-col gap-12" noValidate>
      {state.error ? <InlineAlert tone="danger">{errorMessage(t, state.error)}</InlineAlert> : null}
      <input type="hidden" name="next" value={next} />
      <div className="flex flex-col gap-4">
        <Checkbox
          id="terms-accept"
          name="acceptTerms"
          value="yes"
          required
          defaultChecked={state.values?.["acceptTerms"] === "yes"}
          aria-invalid={termsError ? true : undefined}
          aria-describedby={termsError ? "terms-accept-error" : undefined}
          label={<span className="text-text-13">{termsLabel}</span>}
        />
        {termsError ? (
          <p id="terms-accept-error" className="m-0 text-text-13 text-danger-text">
            {termsError}
          </p>
        ) : null}
      </div>
      {askAge ? <AgeConfirmation id="terms-age" state={state} /> : null}
      <Submit pending={pending}>{t("terms.submit")}</Submit>
    </form>
  );
}
