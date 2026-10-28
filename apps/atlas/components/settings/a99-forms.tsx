"use client";

import { Button, InlineAlert, Input } from "@xos/ui";
import { useActionState } from "react";
import { errorText, useSecurityCopy } from "@/components/auth/security/copy";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { registerOAuthAppAction, type OrgSecurityState } from "./contributions/a99-actions";

/** The OAuth app form on org settings (A99, ADR 0055). */

const INITIAL: OrgSecurityState = {};

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
