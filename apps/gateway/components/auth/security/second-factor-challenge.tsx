"use client";

import { InlineAlert, Select } from "@xos/ui";
import dynamic from "next/dynamic";
import { useState } from "react";
import type { StepUpOptions } from "@/app/auth/security-actions";
import { CodeForm } from "./code-form";
import { errorText, useSecurityCopy } from "./copy";
import { SecurityKeyButton } from "./security-key-button";

/** The recovery code form loads only when the person asks for it (A99). */
const RecoveryCodeForm = dynamic(() =>
  import("./recovery-code-form").then((m) => m.RecoveryCodeForm),
);

/**
 * Asks for one of the person's verified second factors: a code for an authenticator app, the browser prompt for
 * a security key. With several factors the person picks one. A person who holds recovery codes can use one instead
 * (A99). At sign-in it continues to `next`; for step-up it runs `onVerified`.
 */
export function SecondFactorChallenge({
  options,
  mode,
  next,
  onVerified,
}: {
  options: StepUpOptions;
  mode: "sign-in" | "step-up";
  next?: string;
  onVerified?: () => void;
}) {
  const t = useSecurityCopy();
  const usable = options.factors.filter((f) => f.type === "totp" || options.securityKeys);
  const [selected, setSelected] = useState(
    () => (usable.find((f) => f.type === "totp") ?? usable[0])?.id ?? "",
  );
  const [recovery, setRecovery] = useState(false);
  const factor = usable.find((f) => f.id === selected) ?? usable[0];
  const optional = (value: string | undefined) => (value === undefined ? {} : { next: value });
  const switcher = options.recoveryCodes ? (
    <button
      type="button"
      className="min-h-touch-min self-start text-text-13 font-medium text-accent-text underline"
      onClick={() => setRecovery((on) => !on)}
    >
      {t(recovery ? "recovery.useFactor" : "recovery.useInstead")}
    </button>
  ) : null;
  if (recovery || (!factor && options.recoveryCodes)) {
    return (
      <div className="flex flex-col gap-12">
        <RecoveryCodeForm
          mode={mode}
          idPrefix={`${mode}-recovery`}
          {...optional(next)}
          {...(onVerified ? { onVerified } : {})}
        />
        {factor ? switcher : null}
      </div>
    );
  }
  if (!factor) return <InlineAlert tone="warning">{errorText(t, "unsupported")}</InlineAlert>;
  return (
    <div className="flex flex-col gap-12">
      {usable.length > 1 ? (
        <Select
          id={`${mode}-factor`}
          label={t("challenge.factor")}
          value={factor.id}
          options={usable.map((f) => ({
            value: f.id,
            label: `${f.label || t(`factorTypes.${f.type}`)} (${t(`factorTypes.${f.type}`)})`,
          }))}
          onChange={(e) => setSelected(e.currentTarget.value)}
        />
      ) : null}
      {factor.type === "totp" ? (
        <>
          <p className="m-0 text-text-13 text-text-secondary">{t("challenge.sentence")}</p>
          <CodeForm
            key={factor.id}
            factorId={factor.id}
            mode={mode}
            submitLabel={t("challenge.verify")}
            idPrefix={`${mode}-totp`}
            {...optional(next)}
            {...(onVerified ? { onVerified } : {})}
          />
        </>
      ) : (
        <>
          <p className="m-0 text-text-13 text-text-secondary">{t("challenge.keySentence")}</p>
          <SecurityKeyButton
            key={factor.id}
            factorId={factor.id}
            label={t("challenge.useKey")}
            variant="primary"
            {...optional(next)}
            {...(onVerified ? { onVerified } : {})}
          />
        </>
      )}
      {switcher}
    </div>
  );
}
