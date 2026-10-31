"use client";

import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { unsubscribeGuestAction, type UnsubscribeResult } from "@/lib/actions/unsubscribe";

/** Asks before it stops a guest's emails; the action runs only when the button is pressed. */
export function GuestUnsubscribeForm({ token }: { token: string }) {
  const t = useTranslations("gateway.unsubscribe");
  const [state, action, pending] = useActionState<UnsubscribeResult, FormData>(
    unsubscribeGuestAction,
    {},
  );
  return (
    <div className="flex flex-col gap-16">
      <h1>{t("title")}</h1>
      {state.done ? (
        <p role="status">{state.orgName ? t("done", { org: state.orgName }) : t("doneUnknown")}</p>
      ) : (
        <form action={action} className="flex flex-col gap-16">
          <p>{t("questionUnknown")}</p>
          <p>{t("body")}</p>
          <input type="hidden" name="token" value={token} />
          {state.failed && <p role="alert">{t("failed")}</p>}
          <div>
            <Button type="submit" variant="primary" disabled={pending} aria-busy={pending}>
              {t("confirm")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
