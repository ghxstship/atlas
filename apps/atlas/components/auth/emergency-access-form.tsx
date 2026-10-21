"use client";

import { Button, InlineAlert, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useRef } from "react";
import {
  takeEmergencyAccessAction,
  type EmergencyAccessState,
} from "@/app/auth/network-restricted/actions";
import { useStepUpForm } from "@/components/auth/security/step-up";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";

type Translate = (key: string) => string;

const stepUpRefused = (state: EmergencyAccessState) => state.error === "step_up_required";

/**
 * The Owner's emergency access form on the network-restricted page. Break-glass needs a second factor passed in
 * the last 15 minutes; the step-up dialog asks for it (or sets one up) and resubmits (A59-019).
 */
export function EmergencyAccessForm({ org }: { org: string }) {
  const t = useTranslations("shell.auth.networkRestricted");
  const tErr = useTranslations("settings.accessControls.errors") as unknown as Translate;
  const [state, action, pending] = useActionState<EmergencyAccessState, FormData>(
    takeEmergencyAccessAction,
    {},
  );
  const form = useRef<HTMLFormElement>(null);
  const stepUpDialog = useStepUpForm(state, stepUpRefused, form);
  // The dialog renders outside the form: React bubbles a portal's submit event to its tree parents.
  return (
    <>
      {stepUpDialog}
      <form
        ref={form}
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        aria-label={t("ownerTitle")}
        className="flex w-full flex-col gap-12 text-start"
        noValidate
      >
        <input type="hidden" name="org" value={org} />
        {state.error ? <InlineAlert tone="danger">{tErr(state.error)}</InlineAlert> : null}
        <Textarea
          id="emergency-reason"
          name="reason"
          label={t("reason")}
          help={t("reasonHelp")}
          rows={3}
          width="100%"
          maxLength={2000}
        />
        <div>
          <Button type="submit" variant="danger" loading={pending}>
            {t("start")}
          </Button>
        </div>
      </form>
    </>
  );
}
