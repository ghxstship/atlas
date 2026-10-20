"use client";

import { Button, Dialog, InlineAlert, Skeleton } from "@xos/ui";
import { useEffect, useState } from "react";
import { stepUpOptionsAction, type StepUpOptions } from "@/app/auth/security-actions";
import { errorText, useSecurityCopy } from "./copy";
import { SecondFactorChallenge } from "./second-factor-challenge";
import { TotpEnrollment } from "./totp-enrollment";

/**
 * The step-up dialog: the person's second factors to verify with, or, when they have none, the authenticator app
 * enrollment, whose verified code is itself the step-up (A59-019: break-glass no longer dead-ends).
 */
export function StepUpDialog({
  onVerified,
  onCancel,
}: {
  onVerified: () => void;
  onCancel: () => void;
}) {
  const t = useSecurityCopy();
  const [options, setOptions] = useState<StepUpOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void stepUpOptionsAction().then((result) => {
      if (!live) return;
      if (result.ok) setOptions(result.data);
      else setError(result.error);
    });
    return () => {
      live = false;
    };
  }, []);
  const enrolling = options !== null && options.factors.length === 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t(enrolling ? "policy.enrollTitle" : "stepUp.title")}
      description={t(enrolling ? "stepUp.enrollSentence" : "stepUp.sentence")}
      actions={
        <Button type="button" onClick={onCancel}>
          {t("stepUp.cancel")}
        </Button>
      }
    >
      {error ? <InlineAlert tone="danger">{errorText(t, error)}</InlineAlert> : null}
      {options === null && error === null ? <Skeleton width="100%" height={96} /> : null}
      {options && !enrolling ? (
        <SecondFactorChallenge options={options} mode="step-up" onVerified={onVerified} />
      ) : null}
      {enrolling ? (
        <TotpEnrollment variant="primary" idPrefix="step-up" onDone={onVerified} />
      ) : null}
    </Dialog>
  );
}
