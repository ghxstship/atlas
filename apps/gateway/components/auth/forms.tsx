"use client";

import { useTranslations } from "next-intl";
import { useActionState, type ReactNode } from "react";
import {
  sendMagicLink,
  signInWithPassword,
  signUp,
  type FormState,
} from "@/app/auth/actions";
import { Button, InlineAlert, Input } from "@xos/ui";

/** Auth forms (Auth template). Each keeps typed input after a failed submit (Section 11.7). */

type Translate = (key: string, values?: Record<string, string>) => string;

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

export function PasswordSignInForm({ next }: { next: string }) {
  const t = useAuthCopy();
  const [state, action, pending] = useActionState(signInWithPassword, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-12" noValidate>
      {state.error ? <InlineAlert tone="danger">{errorMessage(t, state.error)}</InlineAlert> : null}
      <input type="hidden" name="next" value={next} />
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
      <Submit pending={pending}>{t("signIn.password")}</Submit>
    </form>
  );
}

export function MagicLinkForm({ next, intent }: { next: string; intent: "sign-in" | "sign-up" }) {
  const t = useAuthCopy();
  const [state, action, pending] = useActionState(sendMagicLink, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-12" noValidate>
      {state.error ? <InlineAlert tone="danger">{errorMessage(t, state.error)}</InlineAlert> : null}
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="intent" value={intent} />
      <Input
        width="100%"
        id="magic-email"
        name="email"
        type="email"
        autoComplete="email"
        required
        label={t("fields.email")}
        defaultValue={state.values?.["email"] ?? ""}
        error={fieldError(t, state, "email")}
      />
      <Submit pending={pending}>{t("signIn.magicLink")}</Submit>
    </form>
  );
}

export function SignUpForm({ next }: { next: string }) {
  const t = useAuthCopy();
  const [state, action, pending] = useActionState(signUp, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-12" noValidate>
      {state.error ? <InlineAlert tone="danger">{errorMessage(t, state.error)}</InlineAlert> : null}
      <input type="hidden" name="next" value={next} />
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
      <Input
        width="100%"
        id="signup-password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        required
        label={t("fields.password")}
        help={t("fields.passwordHelp")}
        error={fieldError(t, state, "password")}
      />
      <Submit pending={pending}>{t("signUp.submit")}</Submit>
    </form>
  );
}
