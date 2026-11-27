"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import type { FormState } from "@/app/auth/actions";
import { requestPasswordReset, setNewPassword } from "@/app/auth/password-reset-actions";
import { InlineAlert, Input } from "@xos/ui";
import { errorMessage } from "@/components/auth/error-message";
import { fieldError, INITIAL, Submit, useAuthCopy } from "@/components/auth/forms";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";

/** Moves focus to the first field the server refused, so a keyboard or screen reader user lands on its message. */
function useFocusFirstError(state: FormState, ids: Readonly<Record<string, string>>) {
  const seen = useRef(state);
  useEffect(() => {
    if (seen.current === state) return;
    seen.current = state;
    const field = Object.keys(ids).find((name) => state.fieldErrors?.[name] !== undefined);
    if (field) document.getElementById(ids[field] ?? "")?.focus();
  }, [state, ids]);
}

const REQUEST_FIELDS = { email: "forgot-email" } as const;

/**
 * Asks for a reset link (lib/auth/recovery.ts). After a request the form stays, with the same sentence whether or
 * not an account uses the address, announced as a status; the person can correct the address and ask again.
 */
export function ForgotPasswordForm() {
  const t = useAuthCopy();
  const [state, action, pending] = useActionState(requestPasswordReset, INITIAL);
  useFocusFirstError(state, REQUEST_FIELDS);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      {state.error ? <InlineAlert tone="danger">{errorMessage(t, state.error)}</InlineAlert> : null}
      {state.ok ? (
        <InlineAlert tone="success">
          {t("forgotPassword.sent", { email: state.values?.["email"] ?? "" })}
        </InlineAlert>
      ) : null}
      <Input
        width="100%"
        id={REQUEST_FIELDS.email}
        name="email"
        type="email"
        autoComplete="email"
        required
        label={t("fields.email")}
        defaultValue={state.values?.["email"] ?? ""}
        error={fieldError(t, state, "email")}
      />
      <Submit pending={pending}>{t("forgotPassword.submit")}</Submit>
      <Link href="/auth/sign-in" className="self-start text-text-13 text-accent-text underline">
        {t("forgotPassword.back")}
      </Link>
    </form>
  );
}

const NEW_PASSWORD_FIELDS = { password: "reset-password", confirm: "reset-confirm" } as const;

/**
 * Chooses the new password, typed twice because a reset has no second chance to notice a typo. The hidden username
 * field tells a password manager which account the new password belongs to.
 */
export function NewPasswordForm({ email }: { email: string }) {
  const t = useAuthCopy();
  const [state, action, pending] = useActionState(setNewPassword, INITIAL);
  useFocusFirstError(state, NEW_PASSWORD_FIELDS);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      {state.error ? (
        <InlineAlert tone="danger">
          {errorMessage(t, state.error)}{" "}
          {state.error === "reset_link_invalid" ? (
            <Link href="/auth/forgot-password" className="text-accent-text underline">
              {t("resetPassword.requestNew")}
            </Link>
          ) : null}
        </InlineAlert>
      ) : null}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <Input
        width="100%"
        id={NEW_PASSWORD_FIELDS.password}
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={12}
        label={t("resetPassword.new")}
        help={t("fields.passwordHelp")}
        error={fieldError(t, state, "password")}
      />
      <Input
        width="100%"
        id={NEW_PASSWORD_FIELDS.confirm}
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
        label={t("resetPassword.confirm")}
        error={fieldError(t, state, "confirm")}
      />
      <Submit pending={pending}>{t("resetPassword.submit")}</Submit>
    </form>
  );
}
