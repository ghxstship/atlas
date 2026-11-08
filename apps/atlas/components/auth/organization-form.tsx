"use client";

import { slugFromName } from "@xos/data/slug";
import { Checkbox, InlineAlert, Input, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { createOrganizationAction } from "@/app/auth/actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import {
  AgeConfirmation,
  errorMessage,
  fieldError,
  INITIAL,
  Submit,
  useAuthCopy,
} from "@/components/auth/forms";

/**
 * The organization step (app.create_organization). Its own module, because its country question needs Select and
 * /auth/sign-in, a key page with next to no route budget, imports the other auth forms from forms.tsx.
 */
export function OrganizationForm({
  terms,
  dpa,
  countries,
  askAge = false,
}: {
  terms: { href: string; title: string };
  dpa: { href: string; title: string };
  /** Every country by name, in the reader's language (ADR 0160). */
  countries: readonly { value: string; label: string }[];
  /** The person has not confirmed they are 18 or older yet (a first provider sign-in). */
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
      {state.error ? (
        <InlineAlert tone="danger">{errorMessage(t, state.error, state.errorValues)}</InlineAlert>
      ) : null}
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
      <Select
        id="org-country"
        name="orgCountry"
        label={t("fields.orgCountry")}
        placeholder={t("fields.orgCountryChoose")}
        options={[...countries]}
        {...(state.values?.["orgCountry"] ? { value: state.values["orgCountry"] } : {})}
        {...(fieldError(t, state, "orgCountry")
          ? { error: fieldError(t, state, "orgCountry") }
          : {})}
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
