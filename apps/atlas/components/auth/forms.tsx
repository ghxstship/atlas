"use client";

import { slugFromName } from "@xos/data/slug";
import { useTranslations } from "next-intl";
import { useActionState, useState, type ReactNode } from "react";
import {
  acceptInvitation,
  createOrganizationAction,
  sendMagicLink,
  signInWithPassword,
  signUp,
  type FormState,
} from "@/app/auth/actions";
import { Button, Checkbox, InlineAlert, Input } from "@xos/ui";

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
        minLength={12}
        required
        label={t("fields.password")}
        help={t("fields.passwordHelp")}
        error={fieldError(t, state, "password")}
      />
      <Submit pending={pending}>{t("signUp.submit")}</Submit>
    </form>
  );
}

export function OrganizationForm({
  terms,
  dpa,
}: {
  terms: { href: string; title: string };
  dpa: { href: string; title: string };
}) {
  const t = useAuthCopy();
  const tr = useTranslations("shell.auth.organization");
  const [state, action, pending] = useActionState(createOrganizationAction, INITIAL);
  const [name, setName] = useState(state.values?.["orgName"] ?? "");
  const [slug, setSlug] = useState(state.values?.["orgSlug"] ?? "");
  const [slugEdited, setSlugEdited] = useState(Boolean(state.values?.["orgSlug"]));
  const shownSlug = slugEdited ? slug : slugFromName(name);
  return (
    <form action={action} className="flex flex-col gap-12" noValidate>
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
      <Submit pending={pending}>{t("organization.submit")}</Submit>
    </form>
  );
}

export function AcceptInviteForm({ token }: { token: string }) {
  const t = useAuthCopy();
  const [state, action, pending] = useActionState(acceptInvitation, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-12">
      {state.error ? <InlineAlert tone="danger">{errorMessage(t, state.error)}</InlineAlert> : null}
      <input type="hidden" name="token" value={token} />
      <Submit pending={pending}>{t("invite.accept")}</Submit>
    </form>
  );
}
