"use client";

import { Button, InlineAlert, Input, Select, Textarea, type ButtonProps } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStepUpForm } from "@/components/auth/security/step-up";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import {
  cancelOwnershipAction,
  endStandingGrantAction,
  leavePartnerAction,
  offerOwnershipAction,
  recordStandingGrantAction,
  recoverOrgDeletionAction,
  requestDomainCheckAction,
  requestOrgDeletionAction,
} from "@/lib/lifecycle/actions";
import { INITIAL_PLATFORM_STATE, type PlatformActionState } from "@/lib/platform/state";

/**
 * A79's client forms (Section 4.6.1, Section 12, Section 14.7): each posts to a server action in
 * lib/lifecycle/actions.ts and shows the outcome from the `orgLifecycle` catalog. A step-up refusal opens
 * A77's step-up dialog (useStepUpForm), rendered outside the form, and verifying submits the form again.
 */

type T = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

export function useLifecycleT(): T {
  const t = useTranslations("orgLifecycle");
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

type Action = (state: PlatformActionState, form: FormData) => Promise<PlatformActionState>;

const stepUpRefused = (state: PlatformActionState) => state.rule === "step_up_required";

function Outcome({ state, success }: { state: PlatformActionState; success?: string | undefined }) {
  const t = useLifecycleT();
  if (state.rule) {
    const key = `refusals.${state.rule}`;
    return (
      <InlineAlert tone="warning" title={t("refusedTitle")}>
        {t.has(key) ? t(key) : t("refusals.other")}
        <span className="block font-mono text-text-11 text-text-tertiary">{state.rule}</span>
      </InlineAlert>
    );
  }
  if (state.error) return <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert>;
  if (state.ok && success) return <InlineAlert tone="success">{success}</InlineAlert>;
  return null;
}

function LifecycleForm({
  action,
  org,
  hidden = {},
  label,
  submitLabel,
  submitVariant = "primary",
  success,
  inline = false,
  children,
}: {
  action: Action;
  org: string;
  hidden?: Readonly<Record<string, string>>;
  label: string;
  submitLabel: string;
  submitVariant?: ButtonProps["variant"];
  success?: string;
  inline?: boolean;
  children?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_PLATFORM_STATE);
  const ref = useRef<HTMLFormElement>(null);
  const seen = useRef<number | undefined>(undefined);
  const router = useRouter();
  const stepUp = useStepUpForm(state, stepUpRefused, ref);
  useEffect(() => {
    if (state.ok && state.at !== seen.current) {
      seen.current = state.at;
      ref.current?.reset();
      router.refresh();
    }
  }, [state, router]);
  return (
    <>
      <form
        ref={ref}
        action={formAction}
        onSubmit={keepInputOnSubmit(formAction)}
        aria-label={label}
        className={inline ? "flex flex-wrap items-center gap-8" : "flex flex-col gap-12"}
      >
        <input type="hidden" name="org" value={org} />
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {children}
        <div className="flex flex-wrap items-center gap-8">
          <Button type="submit" variant={submitVariant} loading={pending}>
            {submitLabel}
          </Button>
        </div>
        <div aria-live="polite">
          <Outcome state={state} success={success} />
        </div>
      </form>
      {stepUp}
    </>
  );
}

// Deletion ------------------------------------------------------------------------------------------------------

export function DeleteOrganizationForm({ org, name }: { org: string; name: string }) {
  const t = useLifecycleT();
  return (
    <LifecycleForm
      action={requestOrgDeletionAction}
      org={org}
      label={t("deletion.title")}
      submitLabel={t("deletion.submit")}
      submitVariant="danger"
    >
      <Input
        id="delete-confirm"
        name="confirm"
        label={t("deletion.confirm", { name })}
        required
        autoComplete="off"
        maxLength={200}
        width="100%"
      />
      <Textarea
        id="delete-reason"
        name="reason"
        label={t("deletion.reason")}
        help={t("deletion.reasonHelp")}
        required
        maxLength={1000}
        rows={3}
        width="100%"
      />
    </LifecycleForm>
  );
}

export function RecoverOrganizationForm({ org }: { org: string }) {
  const t = useLifecycleT();
  return (
    <LifecycleForm
      action={recoverOrgDeletionAction}
      org={org}
      label={t("deletion.recover")}
      submitLabel={t("deletion.recover")}
      submitVariant="secondary"
      success={t("deletion.recovered")}
    />
  );
}

// Ownership --------------------------------------------------------------------------------------------------

export function OfferOwnershipForm({
  org,
  members,
}: {
  org: string;
  members: readonly { value: string; label: string }[];
}) {
  const t = useLifecycleT();
  const [person, setPerson] = useState(members[0]?.value ?? "");
  const [outcome, setOutcome] = useState("admin");
  return (
    <LifecycleForm
      action={offerOwnershipAction}
      org={org}
      hidden={{ person, outcome }}
      label={t("transfer.title")}
      submitLabel={t("transfer.submit")}
      submitVariant="secondary"
      success={t("transfer.offered")}
    >
      <Select
        label={t("transfer.member")}
        value={person}
        options={[...members]}
        onChange={(e) => setPerson(e.target.value)}
      />
      <Select
        label={t("transfer.outcome")}
        value={outcome}
        options={[
          { value: "admin", label: t("transfer.outcomeAdmin") },
          { value: "leave", label: t("transfer.outcomeLeave") },
        ]}
        onChange={(e) => setOutcome(e.target.value)}
      />
    </LifecycleForm>
  );
}

export function CancelOwnershipForm({ org, transfer }: { org: string; transfer: string }) {
  const t = useLifecycleT();
  return (
    <LifecycleForm
      action={cancelOwnershipAction}
      org={org}
      hidden={{ transfer }}
      label={t("transfer.cancel")}
      submitLabel={t("transfer.cancel")}
      submitVariant="secondary"
    />
  );
}

// Partners ---------------------------------------------------------------------------------------------------

export function LeavePartnerForm({
  org,
  name,
  partner,
}: {
  org: string;
  name: string;
  partner: string;
}) {
  const t = useLifecycleT();
  return (
    <LifecycleForm
      action={leavePartnerAction}
      org={org}
      label={t("partner.leaveTitle", { partner })}
      submitLabel={t("partner.leaveSubmit", { partner })}
      submitVariant="danger"
    >
      <Input
        id="leave-partner-confirm"
        name="confirm"
        label={t("partner.leaveConfirm", { name })}
        required
        autoComplete="off"
        maxLength={200}
        width="100%"
      />
    </LifecycleForm>
  );
}

export function StandingGrantForm({
  org,
  scopes,
  defaultUntil,
  maxUntil,
}: {
  org: string;
  scopes: readonly { value: string; label: string }[];
  defaultUntil: string;
  maxUntil: string;
}) {
  const t = useLifecycleT();
  const [capability, setCapability] = useState(scopes[0]?.value ?? "");
  return (
    <LifecycleForm
      action={recordStandingGrantAction}
      org={org}
      hidden={{ capability }}
      label={t("partner.grantSubmit")}
      submitLabel={t("partner.grantSubmit")}
      submitVariant="secondary"
      success={t("partner.granted")}
    >
      <Select
        label={t("partner.grantScope")}
        value={capability}
        options={[...scopes]}
        onChange={(e) => setCapability(e.target.value)}
      />
      <Input
        id="grant-until"
        name="until"
        type="date"
        label={t("partner.grantUntil")}
        defaultValue={defaultUntil}
        max={maxUntil}
        required
        width={200}
      />
      <Input
        id="grant-reference"
        name="reference"
        label={t("partner.grantReference")}
        help={t("partner.grantReferenceHelp")}
        required
        maxLength={300}
        width="100%"
      />
    </LifecycleForm>
  );
}

export function EndStandingGrantForm({ org, grant }: { org: string; grant: string }) {
  const t = useLifecycleT();
  return (
    <LifecycleForm
      action={endStandingGrantAction}
      org={org}
      hidden={{ grant }}
      label={t("partner.grantEnd")}
      submitLabel={t("partner.grantEnd")}
      submitVariant="secondary"
      inline
    />
  );
}

// Domains ----------------------------------------------------------------------------------------------------

export function DomainCheckForm({ org, domain }: { org: string; domain: string }) {
  const t = useLifecycleT();
  return (
    <LifecycleForm
      action={requestDomainCheckAction}
      org={org}
      hidden={{ domain }}
      label={t("domains.check")}
      submitLabel={t("domains.check")}
      submitVariant="secondary"
      success={t("domains.checked")}
      inline
    />
  );
}
