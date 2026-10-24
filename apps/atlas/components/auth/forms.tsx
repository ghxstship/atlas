"use client";

import { slugFromName } from "@xos/data/slug";
import { useTranslations } from "next-intl";
import { useActionState, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  acceptInvitation,
  createOrganizationAction,
  signInWithEmail,
  signUpWithEmail,
  type FormState,
} from "@/app/auth/actions";
import { Button, Checkbox, InlineAlert, Input } from "@xos/ui";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
/** Auth forms (Auth template). Each keeps typed input after a failed submit (Section 11.7). */

type Translate = (key: string, values?: Record<string, string>) => string;

function useAuthCopy(): Translate {
  const t = useTranslations("shell.auth");
  return (key, values) => (t as unknown as Translate)(key, values);
}

/** The message for a form state error key: refusals from invites, everything else from errors. */
export function errorMessage(t: Translate, key: string): string {
  return key.startsWith("invite.")
    ? t(`invite.refused.${key.slice("invite.".length)}`)
    : t(`errors.${key}`);
}

/** The field's error message, or an empty string (no error shown). */
function fieldError(t: Translate, state: FormState, field: string): string {
  const key = state.fieldErrors?.[field];
  return key === undefined ? "" : t(`errors.${key}`);
}

const INITIAL: FormState = {};

/**
 * "I am 16 or older" (Section 14.3, 14.9; Terms of Service 3.2). Every way of creating or first
 * using an account asks it; the action records it (migration 1381).
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
        <p id={`${id}-error`} className="m-0 text-text-12 text-danger-text">
          {t("errors.age")}
        </p>
      ) : null}
    </div>
  );
}

function Submit({
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

export function OrganizationForm({
  terms,
  dpa,
  askAge = false,
}: {
  terms: { href: string; title: string };
  dpa: { href: string; title: string };
  /** The person has not confirmed they are 16 or older yet (a first Google sign-in). */
  askAge?: boolean;
}) {
  const t = useAuthCopy();
  const tr = useTranslations("shell.auth.organization");
  const [state, action, pending] = useActionState(createOrganizationAction, INITIAL);
  const [name, setName] = useState(state.values?.["orgName"] ?? "");
  const [slug, setSlug] = useState(state.values?.["orgSlug"] ?? "");
  const [slugEdited, setSlugEdited] = useState(Boolean(state.values?.["orgSlug"]));
  const shownSlug = slugEdited ? slug : slugFromName(name);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      {state.error ? <InlineAlert tone="danger">{errorMessage(t, state.error)}</InlineAlert> : null}
      <Input
        width="100%"
        id="org-name"
        name="orgName"
        autoComplete="organization"
        required
        label={t("fields.orgName")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={fieldError(t, state, "orgName")}
      />
      <Input
        width="100%"
        id="org-slug"
        name="orgSlug"
        required
        spellCheck={false}
        autoCapitalize="none"
        label={t("fields.orgSlug")}
        help={t("fields.orgSlugHelp", { slug: shownSlug })}
        value={shownSlug}
        onChange={(e) => {
          setSlugEdited(true);
          setSlug(e.target.value.toLowerCase());
        }}
        error={fieldError(t, state, "orgSlug")}
      />
      <Checkbox
        id="org-accept"
        name="accept"
        required
        aria-invalid={state.fieldErrors?.["accept"] ? true : undefined}
        aria-describedby={state.fieldErrors?.["accept"] ? "org-accept-error" : undefined}
        label={
          <span className="text-text-13 text-text-secondary">
            {tr.rich("accept", {
              terms: terms.title,
              dpa: dpa.title,
              termsLink: (chunks) => (
                <a className="text-accent-text underline" href={terms.href} target="_blank">
                  {chunks}
                </a>
              ),
              dpaLink: (chunks) => (
                <a className="text-accent-text underline" href={dpa.href} target="_blank">
                  {chunks}
                </a>
              ),
            })}
          </span>
        }
      />
      {state.fieldErrors?.["accept"] ? (
        <p id="org-accept-error" className="text-text-12 text-danger-text">
          {t("errors.accept")}
        </p>
      ) : null}
      {askAge ? <AgeConfirmation id="org-age" state={state} /> : null}
      <Submit pending={pending}>{t("organization.submit")}</Submit>
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
