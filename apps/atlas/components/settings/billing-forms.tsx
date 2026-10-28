"use client";

import { Button, InlineAlert, type ButtonProps } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useMemo, useRef } from "react";
import { useStepUpForm } from "@/components/auth/security/step-up";
import { openBillingPortalAction, startCheckoutAction } from "@/lib/billing/actions";
import { INITIAL_PLATFORM_STATE, type PlatformActionState } from "@/lib/platform/state";
import type { Database } from "@xos/data/database.types";

/**
 * Billing and Plan's buttons (ADR 0033 decision 59): one opens Stripe Checkout for a plan, the other
 * the Stripe customer portal. Each posts to a server action in lib/billing/actions.ts, which answers with the
 * Stripe URL the browser then goes to. A step-up refusal opens A77's step-up dialog, and verifying submits the
 * form again; every other refusal shows its copy under `shell.settings.billing.refusals`.
 */

type Action = (state: PlatformActionState, form: FormData) => Promise<PlatformActionState>;

type T = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

function useBillingT(): T {
  const t = useTranslations("shell.settings.billing");
  return useMemo(() => {
    const call = t as unknown as (k: string, v?: Record<string, string | number>) => string;
    const has = (t as unknown as { has: (k: string) => boolean }).has;
    return Object.assign(
      (key: string, values?: Record<string, string | number>) => call(key, values),
      {
        has: (key: string) => has(key),
      },
    );
  }, [t]);
}

const stepUpRefused = (state: PlatformActionState) => state.rule === "step_up_required";

function Outcome({ state }: { state: PlatformActionState }) {
  const t = useBillingT();
  if (state.rule) {
    const key = `refusals.${state.rule}`;
    return (
      <InlineAlert tone="warning" title={t("refusedTitle")}>
        {t.has(key) ? t(key) : t("refusals.other")}
      </InlineAlert>
    );
  }
  if (state.error) return <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert>;
  if (state.ok) return <p className="m-0 text-text-13 text-text-secondary">{t("redirecting")}</p>;
  return null;
}

function StripeForm({
  action,
  org,
  hidden = {},
  label,
  variant = "secondary",
}: {
  action: Action;
  org: string;
  hidden?: Readonly<Record<string, string>>;
  label: string;
  variant?: ButtonProps["variant"];
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_PLATFORM_STATE);
  const ref = useRef<HTMLFormElement>(null);
  const followed = useRef<number | undefined>(undefined);
  const stepUp = useStepUpForm(state, stepUpRefused, ref);
  useEffect(() => {
    if (state.ok && state.value && state.at !== followed.current) {
      followed.current = state.at;
      window.location.assign(state.value);
    }
  }, [state]);
  return (
    <>
      <form ref={ref} action={formAction} aria-label={label} className="flex flex-col gap-8">
        <input type="hidden" name="org" value={org} />
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <div>
          <Button type="submit" variant={variant} loading={pending || Boolean(state.ok)}>
            {label}
          </Button>
        </div>
        <div aria-live="polite">
          <Outcome state={state} />
        </div>
      </form>
      {stepUp}
    </>
  );
}

/** Opens Stripe Checkout for a self-serve plan and term. */
export function CheckoutButton({
  org,
  plan,
  interval,
  label,
  variant,
}: {
  org: string;
  plan: string;
  interval: Database["app"]["Enums"]["billing_interval"];
  label: string;
  variant?: ButtonProps["variant"];
}) {
  return (
    <StripeForm
      action={startCheckoutAction}
      org={org}
      hidden={{ plan, interval }}
      label={label}
      {...(variant === undefined ? {} : { variant })}
    />
  );
}

/** Opens the Stripe customer portal for the org's customer. */
export function BillingPortalButton({
  org,
  label,
  variant,
}: {
  org: string;
  label: string;
  variant?: ButtonProps["variant"];
}) {
  return (
    <StripeForm
      action={openBillingPortalAction}
      org={org}
      label={label}
      {...(variant === undefined ? {} : { variant })}
    />
  );
}
