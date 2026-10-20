"use client";

import { Button, InlineAlert, Input } from "@xos/ui";
import { useActionState } from "react";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { verifyCodeAction, type SecurityState } from "@/app/auth/security-actions";
import { errorText, useSecurityCopy } from "./copy";

/**
 * Six digits from an authenticator app. At sign-in the action continues to `next`; for step-up and enrollment it
 * reports success and `onVerified` runs. The field takes the one-time code autofill some platforms offer.
 */
export function CodeForm({
  factorId,
  mode,
  next,
  submitLabel,
  onVerified,
  idPrefix = "mfa",
  variant = "primary",
}: {
  factorId: string;
  mode: "sign-in" | "step-up" | "enroll";
  next?: string;
  submitLabel: string;
  onVerified?: () => void;
  idPrefix?: string;
  /** Settings pages keep their one primary action for the page (gate 27). */
  variant?: "primary" | "secondary";
}) {
  const t = useSecurityCopy();
  // At sign-in the server action itself continues (and the form works before hydration). Elsewhere `onVerified`
  // runs from the action's own result, not from an effect: the new session cookies refresh the page in the same
  // response, and a resume that waited for a later render could be lost with it.
  const verify = async (previous: SecurityState, form: FormData): Promise<SecurityState> => {
    const result = await verifyCodeAction(previous, form);
    if (result.ok) onVerified?.();
    return result;
  };
  const [state, action, pending] = useActionState<SecurityState, FormData>(
    mode === "sign-in" ? verifyCodeAction : verify,
    {},
  );
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="factorId" value={factorId} />
      <input type="hidden" name="mode" value={mode} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {state.error ? <InlineAlert tone="danger">{errorText(t, state.error)}</InlineAlert> : null}
      <Input
        width="100%"
        id={`${idPrefix}-code`}
        name="code"
        label={t("challenge.code")}
        help={t("challenge.codeHelp")}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={7}
        required
        autoFocus
      />
      <Button type="submit" variant={variant} loading={pending} className="w-full">
        {submitLabel}
      </Button>
    </form>
  );
}
