"use client";

import { Button, Checkbox, InlineAlert, Input, type ButtonProps } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useStepUpForm } from "@/components/auth/security/step-up";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import {
  endPlanAction,
  openBillingPortalAction,
  startCheckoutAction,
} from "@/lib/billing/actions";
import { INITIAL_PLATFORM_STATE, type PlatformActionState } from "@/lib/platform/state";
import type { Database } from "@xos/data/database.types";

/**
 * Billing and Plan's forms (ADR 0033 decision 59, ADR 0156): one agrees to the renewal terms and opens Stripe Checkout
 * for a plan, one opens the Stripe customer portal, one ends the plan. Checkout and the portal post to a server action in
 * lib/billing/actions.ts, which answers with the Stripe URL the browser then goes to. A step-up refusal opens A77's
 * step-up dialog, and verifying submits the form again; every other refusal shows its copy under
 * `shell.settings.billing.refusals`.
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
  children,
}: {
  action: Action;
  org: string;
  hidden?: Readonly<Record<string, string>>;
  label: string;
  variant?: ButtonProps["variant"];
  children?: ReactNode;
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
      <form
        ref={ref}
        action={formAction}
        onSubmit={keepInputOnSubmit(formAction)}
        aria-label={label}
        className="flex flex-col gap-8"
      >
        <input type="hidden" name="org" value={org} />
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {children}
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

/**
 * Agrees to the renewal terms on the page and opens Stripe Checkout for that plan and term. Nothing is ticked for the
 * Owner; an annual plan also asks for initials (Wisconsin 134.49). The hash ties the agreement to the statement shown.
 */
export function RenewalConsentForm({
  org,
  plan,
  interval,
  hash,
  label,
}: {
  org: string;
  plan: string;
  interval: Database["app"]["Enums"]["billing_interval"];
  hash: string;
  label: string;
}) {
  const t = useBillingT();
  return (
    <StripeForm
      action={startCheckoutAction}
      org={org}
      hidden={{ plan, interval, hash }}
      label={label}
      variant="primary"
    >
      <Checkbox name="agree" required label={t("renewal.agree")} />
      {interval === "Annual" ? (
        <Input
          id="renewal-initials"
          name="initials"
          label={t("renewal.initials")}
          help={t("renewal.initialsHelp")}
          required
          autoComplete="off"
          maxLength={12}
          width="100%"
        />
      ) : null}
    </StripeForm>
  );
}

/** Ends the plan at the end of the period paid for: one button, online, with no second factor (ADR 0156). */
export function EndPlanForm({ org, label }: { org: string; label: string }) {
  const t = useBillingT();
  const [state, formAction, pending] = useActionState(endPlanAction, INITIAL_PLATFORM_STATE);
  return (
    <form
      action={formAction}
      onSubmit={keepInputOnSubmit(formAction)}
      aria-label={label}
      className="flex flex-col gap-8"
    >
      <input type="hidden" name="org" value={org} />
      <div>
        <Button type="submit" variant="secondary" loading={pending}>
          {label}
        </Button>
      </div>
      <div aria-live="polite">
        {state.rule || state.error ? <Outcome state={state} /> : null}
        {state.ok ? <p className="m-0 text-text-13 text-text-secondary">{t("endPlan.sent")}</p> : null}
      </div>
    </form>
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
