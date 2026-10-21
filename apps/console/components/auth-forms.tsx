"use client";

import { Button, InlineAlert, Input } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  signInWithPasswordAction,
  startEnrollmentAction,
  verifySecondFactorAction,
  type EnrollState,
  type SignInState,
  type VerifyState,
} from "@/lib/actions/auth";

/** The password form; it keeps the email after a failed attempt. */
export function PasswordSignIn({ next }: { next: string }) {
  const t = useTranslations("console.auth");
  const [state, action, pending] = useActionState<SignInState, FormData>(
    signInWithPasswordAction,
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-12" aria-label={t("signIn")}>
      <input type="hidden" name="next" value={next} />
      {state.error ? (
        <InlineAlert tone="danger">
          <span data-testid="sign-in-error">{t(`errors.${state.error}`)}</span>
        </InlineAlert>
      ) : null}
      <Input
        id="signin-email"
        name="email"
        type="email"
        autoComplete="username"
        required
        label={t("email")}
        defaultValue={state.email ?? ""}
        width="100%"
      />
      <Input
        id="signin-password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        label={t("password")}
        width="100%"
      />
      <div>
        <Button type="submit" loading={pending}>
          {t("signIn")}
        </Button>
      </div>
    </form>
  );
}

function CodeForm({
  factorId,
  next,
  submitLabel,
}: {
  factorId: string;
  next: string;
  submitLabel: string;
}) {
  const t = useTranslations("console.auth.secondFactor");
  const [state, action, pending] = useActionState<VerifyState, FormData>(
    verifySecondFactorAction,
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-12" aria-label={submitLabel}>
      <input type="hidden" name="factorId" value={factorId} />
      <input type="hidden" name="next" value={next} />
      {state.error ? (
        <InlineAlert tone="danger">{t(`errors.${state.error}` as never)}</InlineAlert>
      ) : null}
      <Input
        id="second-factor-code"
        name="code"
        label={t("code")}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]{6,7}"
        maxLength={7}
        required
      />
      <div>
        <Button type="submit" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Verifies the operator's authenticator app, stepping the session up to a second factor. */
export function VerifySecondFactor({ factorId, next }: { factorId: string; next: string }) {
  const t = useTranslations("console.auth.secondFactor");
  return <CodeForm factorId={factorId} next={next} submitLabel={t("verify")} />;
}

/** Sets up an authenticator app: the QR code and setup key, then the first code turns it on. */
export function EnrollSecondFactor({ next }: { next: string }) {
  const t = useTranslations("console.auth.secondFactor");
  const [label, setLabel] = useState(t("labelDefault"));
  const [state, action, pending] = useActionState<EnrollState, FormData>(startEnrollmentAction, {});
  if (state.factorId && state.qrCode && state.secret) {
    return (
      <div className="flex flex-col gap-12">
        {/* Supabase Auth renders the otpauth URI as an SVG QR code; it carries the secret, so it is never logged. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- a data URI QR code needs no image optimization */}
        <img
          src={state.qrCode}
          alt={t("qr", { name: label })}
          width={176}
          height={176}
          className="self-start rounded-control border border-border-subtle bg-white p-8"
        />
        <p className="m-0 text-text-13 text-text-secondary">{t("keyHelp")}</p>
        <p className="m-0 text-text-13">
          <span className="text-text-secondary">{t("key")}</span>{" "}
          <code className="font-mono" data-testid="setup-key">
            {state.secret}
          </code>
        </p>
        <CodeForm factorId={state.factorId} next={next} submitLabel={t("enrollVerify")} />
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-12" aria-label={t("start")}>
      {state.error ? (
        <InlineAlert tone="danger">{t(`errors.${state.error}` as never)}</InlineAlert>
      ) : null}
      <Input
        id="second-factor-label"
        name="label"
        label={t("label")}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        maxLength={60}
        required
      />
      <div>
        <Button type="submit" loading={pending}>
          {t("start")}
        </Button>
      </div>
    </form>
  );
}
