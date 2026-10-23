"use client";

import { Button, InlineAlert, Input } from "@xos/ui";
import { useActionState } from "react";
import {
  redeemRecoveryCodeAction,
  type AccountSecurityState,
} from "@/app/auth/account-security-actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { errorText, useSecurityCopy } from "./copy";

/**
 * One of the person's saved recovery codes (A99, ADR 0055), at the sign-in challenge or in the step-up dialog. The
 * server spends the code on this session and refreshes it to aal2; at sign-in it continues to `next`, in step-up it
 * reports the codes left and `onVerified` resumes the action. Loaded only when the person asks for it.
 */
export function RecoveryCodeForm({
  mode,
  next,
  onVerified,
  idPrefix = "recovery",
}: {
  mode: "sign-in" | "step-up";
  next?: string;
  onVerified?: () => void;
  idPrefix?: string;
}) {
  const t = useSecurityCopy();
  // As for authenticator codes, the resume runs from the action's own result, never from a later render.
  const redeem = async (previous: AccountSecurityState, form: FormData) => {
    const result = await redeemRecoveryCodeAction(previous, form);
    if (result.ok) onVerified?.();
    return result;
  };
  const [state, action, pending] = useActionState<AccountSecurityState, FormData>(
    mode === "sign-in" ? redeemRecoveryCodeAction : redeem,
    {},
  );
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="mode" value={mode} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {state.error ? <InlineAlert tone="danger">{errorText(t, state.error)}</InlineAlert> : null}
      {state.ok && state.remaining !== undefined ? (
        <p role="status" className="m-0 text-text-13 text-success-text">
          {t("recovery.used", { remaining: state.remaining })}
        </p>
      ) : null}
      <Input
        width="100%"
        id={`${idPrefix}-code`}
        name="code"
        label={t("recovery.code")}
        help={t("recovery.codeHelp")}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={13}
        required
        autoFocus
      />
      <Button type="submit" variant="primary" loading={pending} className="w-full">
        {t("recovery.verify")}
      </Button>
    </form>
  );
}
