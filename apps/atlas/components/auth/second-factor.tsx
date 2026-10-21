"use client";

import { Button, InlineAlert, Input } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import {
  enrollAuthenticator,
  secondFactorStatus,
  verifySecondFactor,
  type Enrollment,
  type SecondFactorStatus,
} from "@/lib/auth/second-factor-actions";

/**
 * Verify a second factor in place, or enrol one first (A59-019, Section 8.4 step-up). In "step-up"
 * mode it appears where an action was refused for want of a second factor and calls `onVerified`
 * once the session has passed one, so the caller retries the action. In "manage" mode (Personal
 * settings > Security) it lists the person's authenticator apps and adds one.
 */
export function SecondFactor({
  mode,
  onVerified,
}: {
  mode: "step-up" | "manage";
  onVerified?: () => void;
}) {
  const t = useTranslations("shell.secondFactor");
  const [status, setStatus] = useState<SecondFactorStatus | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    void secondFactorStatus().then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, []);

  const factorId = enrollment?.factorId ?? status?.factors[0]?.id ?? null;

  const verify = () =>
    start(async () => {
      if (!factorId) return;
      setError(null);
      const result = await verifySecondFactor({ factorId, code });
      if (!result.ok) {
        setError(t(`errors.${result.error}`));
        return;
      }
      setDone(true);
      setEnrollment(null);
      setCode("");
      setStatus(await secondFactorStatus());
      onVerified?.();
    });

  const enrol = () =>
    start(async () => {
      setError(null);
      const created = await enrollAuthenticator();
      if (!created) setError(t("errors.unexpected"));
      else setEnrollment(created);
    });

  if (status === null) {
    return (
      <p role="status" className="m-0 text-text-13 text-text-secondary">
        {t("loading")}
      </p>
    );
  }

  const codeForm = (
    <form
      className="flex flex-wrap items-end gap-8"
      onSubmit={(e) => {
        e.preventDefault();
        verify();
      }}
    >
      <Input
        id={`second-factor-code-${mode}`}
        name="code"
        label={t("code")}
        help={t("codeHelp")}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        width={160}
        error={error ?? ""}
      />
      <Button type="submit" variant="primary" loading={pending}>
        {t("verify")}
      </Button>
    </form>
  );

  let body;
  if (enrollment) {
    body = (
      <div className="flex flex-col gap-12">
        <p className="m-0 text-text-13">{t("scan")}</p>
        {/* The QR code is an SVG data URL from Supabase Auth, shown once to the person enrolling. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={enrollment.qrCode}
          alt={t("qrAlt")}
          width={176}
          height={176}
          className="rounded-card border border-border-subtle bg-white p-8"
        />
        <p className="m-0 text-text-12 text-text-secondary">
          {t("secret")} <code className="font-mono">{enrollment.secret}</code>
        </p>
        {codeForm}
      </div>
    );
  } else if (status.factors.length === 0) {
    body = (
      <div className="flex flex-col gap-8">
        <p className="m-0 text-text-13">{mode === "step-up" ? t("noneStepUp") : t("none")}</p>
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        <div>
          <Button
            variant={mode === "step-up" ? "primary" : "secondary"}
            onClick={enrol}
            loading={pending}
          >
            {t("enrol")}
          </Button>
        </div>
      </div>
    );
  } else if (mode === "step-up") {
    body = done ? null : (
      <div className="flex flex-col gap-8">
        <p className="m-0 text-text-13">{t("stepUp")}</p>
        {codeForm}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-8">
        <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
          {status.factors.map((f) => (
            <li key={f.id}>{f.name ?? t("authenticator")}</li>
          ))}
        </ul>
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        <div>
          <Button variant="secondary" onClick={enrol} loading={pending}>
            {t("enrolAnother")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-12">
      {done ? (
        <p role="status" className="m-0 text-text-13 text-success-text">
          {mode === "step-up" ? t("verifiedRetry") : t("verified")}
        </p>
      ) : null}
      {body}
    </div>
  );
}
