"use client";

import { Button, Checkbox, InlineAlert, Input, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useRef, useState } from "react";
import { errorText, useSecurityCopy } from "@/components/auth/security/copy";
import { useStepUpForm } from "@/components/auth/security/step-up";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { ChoiceDisclosure, useCheckedCount } from "./choice-disclosure";
import {
  apiKeySavedAction,
  createApiKeyAction,
  registerOAuthAppAction,
  type OrgSecurityState,
} from "./contributions/a99-actions";

/**
 * Forms for API keys and OAuth apps on org settings (A99, ADR 0055). Creating a key asks for step-up: the refusal opens
 * the step-up dialog, which resubmits the form; the secret then shows once.
 */

const INITIAL: OrgSecurityState = {};

export function CreateApiKeyForm({
  org,
  groups,
  scopeLabels,
}: {
  org: string;
  groups: readonly string[];
  scopeLabels: Readonly<Record<string, string>>;
}) {
  const t = useSecurityCopy();
  const chosen = useTranslations("settings");
  const {
    ref: scopesRef,
    count: scopesChosen,
    recount: recountScopes,
  } = useCheckedCount<HTMLFieldSetElement>(0);
  const [state, dispatch, pending] = useActionState(createApiKeyAction, INITIAL);
  const form = useRef<HTMLFormElement>(null);
  const stepUp = useStepUpForm(state, (s) => s.error === "step_up_required", form);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [days, setDays] = useState("90");
  const secret = state.secret && state.secret !== saved ? state.secret : null;

  if (secret) {
    return (
      <div className="flex flex-col gap-12">
        <InlineAlert tone="warning">{t("apiKeys.created")}</InlineAlert>
        <Input
          width="100%"
          id="api-key-secret"
          label={t("apiKeys.secret")}
          value={secret}
          readOnly
        />
        <div className="flex flex-wrap gap-8">
          <Button
            type="button"
            variant="secondary"
            icon="Copy"
            onClick={() => void navigator.clipboard.writeText(secret).then(() => setCopied(true))}
          >
            {t("apiKeys.copy")}
          </Button>
          <form
            action={async (data: FormData) => {
              setSaved(secret);
              setCopied(false);
              await apiKeySavedAction(data);
            }}
          >
            <input type="hidden" name="org" value={org} />
            <Button type="submit" variant="primary">
              {t("apiKeys.done")}
            </Button>
          </form>
        </div>
        {copied ? (
          <p role="status" className="m-0 text-text-12 text-success-text">
            {t("apiKeys.copied")}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <form
        ref={form}
        action={dispatch}
        onSubmit={keepInputOnSubmit(dispatch)}
        className="flex flex-col gap-12"
        noValidate
      >
        <input type="hidden" name="org" value={org} />
        {state.error && state.error !== "step_up_required" ? (
          <InlineAlert tone="danger">{errorText(t, state.error)}</InlineAlert>
        ) : null}
        <Input
          width="100%"
          id="api-key-name"
          name="name"
          label={t("apiKeys.name")}
          help={t("apiKeys.nameHelp")}
          maxLength={120}
          required
          {...(state.fieldErrors?.["name"] ? { error: errorText(t, "invalid") } : {})}
        />
        {/* Every scope is a box, more than a form may show, so they sit closed behind how many are chosen (gate 27). */}
        <fieldset
          ref={scopesRef}
          onChange={recountScopes}
          className="m-0 flex flex-col gap-8 border-0 p-0"
        >
          <legend className="sr-only">{t("apiKeys.scopes")}</legend>
          <ChoiceDisclosure
            title={t("apiKeys.scopes")}
            summary={chosen("chosen", { count: scopesChosen, total: groups.length })}
            open={Boolean(state.fieldErrors?.["scopes"])}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {groups.map((group) => (
                <Checkbox
                  key={group}
                  name="scopes"
                  value={group}
                  label={scopeLabels[group] ?? group}
                />
              ))}
            </div>
          </ChoiceDisclosure>
          {state.fieldErrors?.["scopes"] ? (
            <p className="m-0 text-text-12 text-danger-text">{t("apiKeys.scopesNone")}</p>
          ) : null}
        </fieldset>
        <Select
          id="api-key-days"
          name="days"
          label={t("apiKeys.expires")}
          value={days}
          onChange={(e) => setDays(e.currentTarget.value)}
          options={[30, 90, 180, 365].map((count) => ({
            value: String(count),
            label: t("apiKeys.days", { count }),
          }))}
        />
        <div>
          <Button type="submit" variant="secondary" icon="Plus" loading={pending}>
            {t("apiKeys.create")}
          </Button>
        </div>
      </form>
      {stepUp}
    </>
  );
}

export function RegisterOAuthAppForm({ org }: { org: string }) {
  const t = useSecurityCopy();
  const [state, dispatch, pending] = useActionState(registerOAuthAppAction, INITIAL);
  return (
    <form
      action={dispatch}
      onSubmit={keepInputOnSubmit(dispatch)}
      className="flex flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      {state.error ? <InlineAlert tone="danger">{errorText(t, state.error)}</InlineAlert> : null}
      {state.ok ? (
        <p role="status" className="m-0 text-text-12 text-success-text">
          {t("oauthApps.registered")}
        </p>
      ) : null}
      <Input
        width="100%"
        id="oauth-app-name"
        name="name"
        label={t("oauthApps.name")}
        maxLength={120}
        required
        {...(state.fieldErrors?.["name"] ? { error: errorText(t, "invalid") } : {})}
      />
      <Input
        width="100%"
        id="oauth-app-redirect"
        name="redirectUri"
        type="url"
        label={t("oauthApps.redirect")}
        help={t("oauthApps.redirectHelp")}
        maxLength={2000}
        required
        {...(state.fieldErrors?.["redirectUri"] ? { error: errorText(t, "invalid") } : {})}
      />
      <div>
        <Button type="submit" variant="secondary" icon="Plus" loading={pending}>
          {t("oauthApps.register")}
        </Button>
      </div>
    </form>
  );
}
