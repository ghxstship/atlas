"use client";

import { Select, Textarea } from "@xos/ui";
import { useState } from "react";
import { ActionForm, usePlatformT } from "@/components/platform/kit";
import {
  fileModerationAppealAction,
  grantPlatformSupportAction,
} from "@/components/settings/contributions/a90-actions";

/** The Owner grants the platform team a support session of 1 to 24 hours with a reason (A90, Section 8). */
export function GrantPlatformSupportForm({ org }: { org: string }) {
  const t = usePlatformT();
  const [hours, setHours] = useState("4");
  return (
    <ActionForm
      action={grantPlatformSupportAction}
      hidden={{ org, hours }}
      label={t("access.platformSupport.grant")}
      submitLabel={t("access.platformSupport.grant")}
      success={t("access.platformSupport.granted")}
    >
      <Select
        label={t("access.support.hours")}
        value={hours}
        options={["1", "2", "4", "8", "24"].map((h) => ({
          value: h,
          label: t("access.support.hoursOption", { hours: Number(h) }),
        }))}
        onChange={(e) => setHours(e.target.value)}
      />
      <Textarea
        id="platform-support-reason"
        name="reason"
        label={t("access.platformSupport.reason")}
        help={t("access.platformSupport.reasonHelp")}
        required
        maxLength={500}
        rows={2}
        width="100%"
      />
    </ActionForm>
  );
}

/** The affected party appeals a removal or restriction within six months (Digital Services Act article 20). */
export function ModerationAppealForm({ org, decision }: { org: string; decision: string }) {
  const t = usePlatformT();
  return (
    <ActionForm
      action={fileModerationAppealAction}
      hidden={{ org, decision }}
      label={t("moderation.appeal")}
      submitLabel={t("moderation.appeal")}
      success={t("moderation.appealed")}
      submitVariant="secondary"
    >
      <Textarea
        id={`appeal-${decision}`}
        name="grounds"
        label={t("moderation.grounds")}
        help={t("moderation.groundsHelp")}
        required
        maxLength={4000}
        rows={3}
        width="100%"
      />
    </ActionForm>
  );
}
