"use client";

import { Button, InlineAlert, Input } from "@xos/ui";
import { useActionState, useEffect, useRef } from "react";
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
  const [state, action, pending] = useActionState<SecurityState, FormData>(verifyCodeAction, {});
  const handled = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (state.ok && state.at !== handled.current) {
      handled.current = state.at;
      onVerified?.();
    }
  }, [state, onVerified]);
  return (
    <form action={action} className="flex flex-col gap-12" noValidate>
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
