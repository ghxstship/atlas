"use client";

import { Button, InlineAlert, Input } from "@xos/ui";
import { useState, useTransition } from "react";
import {
  cancelEnrollmentAction,
  startTotpAction,
  type TotpSetup,
} from "@/app/auth/security-actions";
import { CodeForm } from "./code-form";
import { errorText, useSecurityCopy } from "./copy";

/**
 * Enrolls an authenticator app: name it, scan the QR code (or type the setup key), then verify a code. The
 * factor counts only after the code verifies, which also steps the session up. Cancel removes the unfinished
 * enrollment.
 */
export function TotpEnrollment({
  onDone,
  variant = "secondary",
  idPrefix = "totp",
}: {
  onDone?: () => void;
  variant?: "primary" | "secondary";
  idPrefix?: string;
}) {
  const t = useSecurityCopy();
  const [name, setName] = useState(() => t("enroll.totpDefault"));
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [finished, setFinished] = useState(false);
  const [pending, start] = useTransition();

  const begin = () =>
    start(async () => {
      setError(null);
      const result = await startTotpAction(name);
      if (!result.ok) return setError(result.error);
      setSetup(result.data);
      setShowSecret(false);
    });

  const cancel = () =>
    start(async () => {
      if (setup) await cancelEnrollmentAction(setup.factorId);
      setSetup(null);
    });

  if (finished) {
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {t("enroll.done")}
      </p>
    );
  }

  if (setup === null) {
    return (
      <div className="flex flex-col gap-12">
        {error ? <InlineAlert tone="danger">{errorText(t, error)}</InlineAlert> : null}
        <Input
          width="100%"
          id={`${idPrefix}-label`}
          label={t("enroll.label")}
          help={t("enroll.labelHelp")}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <div>
          <Button
            type="button"
            variant={variant}
            icon="Smartphone"
            loading={pending}
            onClick={begin}
          >
            {t("enroll.start")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-12">
      <p className="m-0 text-text-13">{t("enroll.scan")}</p>
      {/* Supabase Auth renders the otpauth URI as an SVG QR code; it carries the secret, so it is never logged. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- a data URI QR code needs no image optimization */}
      <img
        src={setup.qrCode}
        alt={t("enroll.qrAlt")}
        width={176}
        height={176}
        className="rounded-control border border-border-subtle bg-white p-8"
      />
      {showSecret ? (
        <p className="m-0 flex flex-col gap-4 text-text-13">
          <span className="text-text-secondary">{t("enroll.secret")}</span>
          <code className="font-mono text-label-13 break-all select-all">{setup.secret}</code>
        </p>
      ) : (
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowSecret(true)}>
            {t("enroll.showSecret")}
          </Button>
        </div>
      )}
      <CodeForm
        factorId={setup.factorId}
        mode="enroll"
        submitLabel={t("enroll.confirm")}
        idPrefix={idPrefix}
        variant={variant}
        onVerified={() => {
          setFinished(true);
          onDone?.();
        }}
      />
      <div>
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={cancel}>
          {t("enroll.cancel")}
        </Button>
      </div>
    </div>
  );
}
