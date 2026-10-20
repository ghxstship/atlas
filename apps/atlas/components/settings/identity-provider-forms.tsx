"use client";

import { Button, Checkbox, InlineAlert, Input, Select } from "@xos/ui";
import { useActionState, useRef } from "react";
import { useStepUpForm } from "@/components/auth/security/step-up";
import { errorText, useSecurityCopy } from "@/components/auth/security/copy";
import {
  addProviderAction,
  issueScimTokenAction,
  updateProviderAction,
  type ProviderState,
} from "./contributions/a77-actions";

/**
 * Forms for Enterprise single sign-on and SCIM on Settings, Security (A77): add an identity provider XOS support
 * connected, change who it adds and with which role, and issue the SCIM token, which needs step-up. None uses the
 * primary button: the page's registry section owns the one primary action (gate 27).
 */

type Option = { readonly value: string; readonly label: string };
const INITIAL: ProviderState = {};

function Status({ state, saved }: { state: ProviderState; saved: string }) {
  const t = useSecurityCopy();
  if (state.error && state.error !== "step_up_required") {
    return <InlineAlert tone="danger">{errorText(t, state.error)}</InlineAlert>;
  }
  if (state.fieldErrors) return <InlineAlert tone="danger">{errorText(t, "invalid")}</InlineAlert>;
  if (state.ok && !state.token) {
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {saved}
      </p>
    );
  }
  return null;
}

export function AddProviderForm({ org, roles }: { org: string; roles: readonly Option[] }) {
  const t = useSecurityCopy();
  const [state, action, pending] = useActionState(addProviderAction, INITIAL);
  const invalid = (field: string) => (state.fieldErrors?.[field] ? errorText(t, "invalid") : "");
  return (
    <form
      action={action}
      aria-label={t("providers.add")}
      className="flex max-w-layout-form flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <Status state={state} saved={t("providers.saved")} />
      <Input
        id="provider-name"
        name="name"
        label={t("providers.name")}
        help={t("providers.nameHelp")}
        width="100%"
        maxLength={120}
        error={invalid("name")}
      />
      <div className="flex flex-wrap items-end gap-12">
        <Select
          id="provider-protocol"
          name="protocol"
          label={t("providers.protocol")}
          value="SAML"
          options={[
            { value: "SAML", label: "SAML 2.0" },
            { value: "OIDC", label: "OpenID Connect" },
          ]}
        />
        <Select
          id="provider-role"
          name="defaultRoleId"
          label={t("providers.defaultRole")}
          value={roles[0]?.value ?? ""}
          options={[...roles]}
        />
      </div>
      <Input
        id="provider-id"
        name="authProviderId"
        label={t("providers.providerId")}
        help={t("providers.providerIdHelp")}
        width="100%"
        maxLength={200}
        error={invalid("authProviderId")}
      />
      <Checkbox id="provider-jit" name="jit" label={t("providers.jit")} defaultChecked />
      <Checkbox id="provider-scim" name="scim" label={t("providers.scim")} />
      <div>
        <Button type="submit" loading={pending}>
          {t("providers.add")}
        </Button>
      </div>
    </form>
  );
}

export function ProviderSettingsForm({
  org,
  providerId,
  name,
  roles,
  defaultRoleId,
  jitEnabled,
  scimEnabled,
}: {
  org: string;
  providerId: string;
  name: string;
  roles: readonly Option[];
  defaultRoleId: string;
  jitEnabled: boolean;
  scimEnabled: boolean;
}) {
  const t = useSecurityCopy();
  const [state, action, pending] = useActionState(updateProviderAction, INITIAL);
  return (
    <form action={action} aria-label={name} className="flex flex-col gap-8" noValidate>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="providerId" value={providerId} />
      <Select
        id={`provider-role-${providerId}`}
        name="defaultRoleId"
        label={t("providers.defaultRole")}
        value={defaultRoleId}
        options={[...roles]}
      />
      <Checkbox
        id={`provider-jit-${providerId}`}
        name="jit"
        label={t("providers.jit")}
        defaultChecked={jitEnabled}
      />
      <Checkbox
        id={`provider-scim-${providerId}`}
        name="scim"
        label={t("providers.scim")}
        defaultChecked={scimEnabled}
      />
      <div>
        <Button type="submit" size="sm" loading={pending}>
          {t("providers.save")}
        </Button>
      </div>
      <Status state={state} saved={t("providers.saved")} />
    </form>
  );
}

const stepUpRefused = (state: ProviderState) => state.error === "step_up_required";

export function ScimTokenForm({
  org,
  providerId,
  issued,
}: {
  org: string;
  providerId: string;
  issued: boolean;
}) {
  const t = useSecurityCopy();
  const [state, action, pending] = useActionState(issueScimTokenAction, INITIAL);
  const form = useRef<HTMLFormElement>(null);
  const stepUpDialog = useStepUpForm(state, stepUpRefused, form);
  // The dialog renders outside the form: React bubbles a portal's submit event to its tree parents.
  return (
    <>
      {stepUpDialog}
      <form ref={form} action={action} className="flex flex-col gap-8">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="providerId" value={providerId} />
        <div>
          <Button type="submit" size="sm" variant="secondary" loading={pending}>
            {t(issued ? "providers.rotateToken" : "providers.issueToken")}
          </Button>
        </div>
        <Status state={state} saved={t("providers.saved")} />
        {state.token ? (
          <div role="status" className="flex flex-col gap-4">
            <code className="font-mono text-label-13 break-all select-all">{state.token}</code>
            <span className="text-text-12 text-text-secondary">{t("providers.tokenOnce")}</span>
          </div>
        ) : null}
      </form>
    </>
  );
}
