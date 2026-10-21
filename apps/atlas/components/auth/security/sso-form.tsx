"use client";

import { Button, InlineAlert, Input } from "@xos/ui";
import { useActionState } from "react";
import { ssoSignInAction, type SecurityState } from "@/app/auth/security-actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { errorText, useSecurityCopy } from "./copy";

/** Enterprise single sign-on by work email: continues to the identity provider for the email's domain. */
export function SsoForm({ next }: { next: string }) {
  const t = useSecurityCopy();
  const [state, action, pending] = useActionState<SecurityState, FormData>(ssoSignInAction, {});
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      {state.error ? <InlineAlert tone="danger">{errorText(t, state.error)}</InlineAlert> : null}
      <input type="hidden" name="next" value={next} />
      <Input
        width="100%"
        id="sso-email"
        name="email"
        type="email"
        autoComplete="email"
        required
        label={t("sso.email")}
      />
      <Button type="submit" variant="primary" loading={pending} className="w-full">
        {t("sso.continue")}
      </Button>
    </form>
  );
}
