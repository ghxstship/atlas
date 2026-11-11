"use client";

import { Button, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { FormShell } from "@/components/engagement/forms";
import type { FormResult } from "@/lib/actions/operations";
import { declineStillComingAction } from "@/lib/actions/still-coming";

type Translate = (key: string) => string;

/** "Can't make it" on a Still coming? ask (B9): opens a form for an optional reason, kept after a refusal. */
export function StillComingDecline({ notificationId }: { notificationId: string }) {
  const t = useTranslations("gateway.home.needsYou") as unknown as Translate;
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<FormResult, FormData>(
    declineStillComingAction,
    {},
  );
  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {t("stillComingNo")}
      </Button>
    );
  }
  return (
    <FormShell
      row
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("stillComingNo")}
      doneLabel={t("stillComingDeclined")}
      label={t("stillComingNo")}
    >
      <input type="hidden" name="notificationId" value={notificationId} />
      <Textarea
        id={`still-coming-${notificationId}`}
        name="reason"
        label={t("stillComingReason")}
        maxLength={500}
        rows={2}
      />
    </FormShell>
  );
}
