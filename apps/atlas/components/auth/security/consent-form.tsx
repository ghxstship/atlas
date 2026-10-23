"use client";

import { Button, InlineAlert } from "@xos/ui";
import { useActionState, useRef } from "react";
import { allowAppAction, denyAppAction, type ConsentState } from "@/app/oauth/consent/actions";
import { errorText, useSecurityCopy } from "./copy";
import { useStepUpForm } from "./step-up";

/**
 * Allow and Deny on the consent page (A99, ADR 0055). Allowing Restricted groups asks for step-up: the refusal opens the
 * step-up dialog, and verifying submits Allow again. Both buttons work before hydration.
 */
export function ConsentForm({
  authorizationId,
  canAllow,
}: {
  authorizationId: string;
  canAllow: boolean;
}) {
  const t = useSecurityCopy();
  const [allowState, allow, allowing] = useActionState<ConsentState, FormData>(allowAppAction, {});
  const [denyState, deny, denying] = useActionState<ConsentState, FormData>(denyAppAction, {});
  const form = useRef<HTMLFormElement>(null);
  const stepUp = useStepUpForm(allowState, (s) => s.error === "step_up_required", form);
  const error =
    allowState.error && allowState.error !== "step_up_required"
      ? allowState.error
      : (denyState.error ?? null);
  return (
    <div className="flex flex-col gap-12">
      {error ? <InlineAlert tone="danger">{errorText(t, error)}</InlineAlert> : null}
      <div className="flex flex-wrap gap-8">
        {canAllow ? (
          <form ref={form} action={allow}>
            <input type="hidden" name="authorizationId" value={authorizationId} />
            <Button type="submit" variant="primary" loading={allowing}>
              {t("consent.allow")}
            </Button>
          </form>
        ) : null}
        <form action={deny}>
          <input type="hidden" name="authorizationId" value={authorizationId} />
          <Button type="submit" variant="secondary" loading={denying}>
            {t("consent.deny")}
          </Button>
        </form>
      </div>
      {stepUp}
    </div>
  );
}
