"use client";

import { Button, InlineAlert, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  takeEmergencyAccessAction,
  type EmergencyAccessState,
} from "@/app/auth/network-restricted/actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { SecondFactor } from "./second-factor";

type Translate = (key: string) => string;

/** The Owner's emergency access form on the network-restricted page. */
export function EmergencyAccessForm({ org }: { org: string }) {
  const t = useTranslations("shell.auth.networkRestricted");
  const tErr = useTranslations("settings.accessControls.errors") as unknown as Translate;
  const [state, action, pending] = useActionState<EmergencyAccessState, FormData>(
    takeEmergencyAccessAction,
    {},
  );
  // Without a second factor, verify (or set one up) in place, then retry (A59-019).
  const stepUp = state.error === "step_up_required";
  return (
    <div className="flex w-full flex-col gap-12 text-start">
      {stepUp ? (
        <SecondFactor
          mode="step-up"
          onVerified={() =>
            (
              document.getElementById("emergency-access-form") as HTMLFormElement | null
            )?.requestSubmit()
          }
        />
      ) : null}
      <form
        id="emergency-access-form"
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        aria-label={t("ownerTitle")}
        className="flex w-full flex-col gap-12 text-start"
        noValidate
      >
        <input type="hidden" name="org" value={org} />
        {state.error && !stepUp ? (
          <InlineAlert tone="danger">{tErr(state.error)}</InlineAlert>
        ) : null}
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
    </div>
  );
}
