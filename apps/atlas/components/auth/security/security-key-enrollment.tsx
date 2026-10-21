"use client";

import { createCredential } from "@xos/data/webauthn-json";
import { Button, InlineAlert, Input } from "@xos/ui";
import { useState, useTransition } from "react";
import {
  securityKeyVerifyAction,
  startSecurityKeyEnrollmentAction,
} from "@/app/auth/security-actions";
import { errorText, useSecurityCopy } from "./copy";
import { useStepUp } from "./step-up";

/**
 * Enrolls a security key, or a passkey, as a second factor (WebAuthn through Supabase Auth MFA). Supabase Auth
 * asks for aal2 to add a factor once one is verified; that refusal opens the step-up dialog and resumes here.
 */
export function SecurityKeyEnrollment({ onDone }: { onDone?: () => void }) {
  const t = useSecurityCopy();
  const [name, setName] = useState(() => t("enroll.keyDefault"));
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [pending, start] = useTransition();
  const stepUp = useStepUp();

  const enroll = () =>
    start(async () => {
      setError(null);
      const challenge = await startSecurityKeyEnrollmentAction(name);
      if (!challenge.ok) {
        if (challenge.error === "step_up_required") return stepUp.request(enroll);
        return setError(challenge.error);
      }
      const { ceremony, challengeId, factorId } = challenge.data;
      if (ceremony.kind !== "create") return setError("unexpected");
      const result = await createCredential(ceremony.options);
      if (!result.ok) return setError(result.reason);
      const verified = await securityKeyVerifyAction({
        factorId,
        challengeId,
        kind: "create",
        credential: result.credential,
      });
      if (!verified.ok) return setError(verified.error);
      setFinished(true);
      onDone?.();
    });

  if (finished) {
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {t("enroll.keyDone")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-12">
      {error ? <InlineAlert tone="danger">{errorText(t, error)}</InlineAlert> : null}
      <Input
        width="100%"
        id="security-key-label"
        label={t("enroll.label")}
        help={t("enroll.labelHelp")}
        value={name}
        maxLength={80}
        onChange={(e) => setName(e.currentTarget.value)}
      />
      <div>
        <Button type="button" variant="secondary" icon="Lock" loading={pending} onClick={enroll}>
          {t("enroll.addKey")}
        </Button>
      </div>
      {stepUp.dialog}
    </div>
  );
}
