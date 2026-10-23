"use client";

import { Button, Dialog, InlineAlert } from "@xos/ui";
import { useState, useTransition } from "react";
import {
  generateRecoveryCodesAction,
  recoveryCodesSavedAction,
} from "@/app/auth/account-security-actions";
import { errorText, useSecurityCopy } from "./copy";
import { useStepUp } from "./step-up";

/**
 * Makes a set of recovery codes (A99, ADR 0055): step-up first (a second factor in the last 15 minutes), then the ten
 * codes appear once, to copy or download. Making a new set while codes exist is confirmed, because the old set stops
 * working at once. The page refreshes only after the person says they saved them.
 */
export function RecoveryCodesControl({ hasCodes, today }: { hasCodes: boolean; today: string }) {
  const t = useSecurityCopy();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const stepUp = useStepUp();

  const generate = () =>
    start(async () => {
      setError(null);
      setConfirming(false);
      const result = await generateRecoveryCodesAction();
      if (!result.ok) {
        if (result.error === "step_up_required") return stepUp.request(generate);
        return setError(result.error);
      }
      setCopied(false);
      setCodes(result.data);
    });

  const text = (list: string[]) =>
    [t("recovery.fileHeading"), t("recovery.fileNote", { date: today }), "", ...list, ""].join(
      "\n",
    );

  if (codes) {
    return (
      <div className="flex flex-col gap-12">
        <InlineAlert tone="warning">{t("recovery.shownOnce")}</InlineAlert>
        <ol
          aria-label={t("recovery.listLabel")}
          className="m-0 grid list-none grid-cols-2 gap-8 rounded-md border border-border-subtle p-12 font-mono text-text-14"
        >
          {codes.map((code) => (
            <li key={code} className="break-all">
              {code}
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-8">
          <Button
            type="button"
            variant="secondary"
            icon="Copy"
            onClick={() => {
              void navigator.clipboard.writeText(text(codes)).then(() => setCopied(true));
            }}
          >
            {t("recovery.copy")}
          </Button>
          <a
            className="inline-flex min-h-touch-min items-center rounded-md border border-border-default px-12 text-label-13 font-medium"
            href={`data:text/plain;charset=utf-8,${encodeURIComponent(text(codes))}`}
            download="xos-recovery-codes.txt"
          >
            {t("recovery.download")}
          </a>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              setCodes(null);
              void recoveryCodesSavedAction();
            }}
          >
            {t("recovery.done")}
          </Button>
        </div>
        {copied ? (
          <p role="status" className="m-0 text-text-12 text-success-text">
            {t("recovery.copied")}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-12">
      {error ? <InlineAlert tone="danger">{errorText(t, error)}</InlineAlert> : null}
      {hasCodes ? (
        <Dialog
          open={confirming}
          onOpenChange={setConfirming}
          trigger={
            <Button type="button" variant="secondary" loading={pending}>
              {t("recovery.regenerate")}
            </Button>
          }
          title={t("recovery.regenerateTitle")}
          description={t("recovery.regenerateSentence")}
          actions={
            <>
              <Button type="button" onClick={() => setConfirming(false)}>
                {t("sessions.cancel")}
              </Button>
              <Button type="button" variant="danger" loading={pending} onClick={generate}>
                {t("recovery.regenerate")}
              </Button>
            </>
          }
        >
          {null}
        </Dialog>
      ) : (
        <div>
          <Button type="button" variant="secondary" loading={pending} onClick={generate}>
            {t("recovery.generate")}
          </Button>
        </div>
      )}
      {stepUp.dialog}
    </div>
  );
}
