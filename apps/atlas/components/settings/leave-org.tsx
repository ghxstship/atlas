"use client";

import { Button, Dialog, InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { leaveOrganizationAction, type LeaveState } from "@/app/[org]/me/actions";

/** Leave an org, confirmed in a dialog because access ends at once (Section 11.10). */
export function LeaveOrganizationButton({ orgId, orgName }: { orgId: string; orgName: string }) {
  const t = useTranslations("shell.settings.organizations");
  const tm = useTranslations("shell.settings.members");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<LeaveState, FormData>(
    leaveOrganizationAction,
    {},
  );
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="ghost" size="sm">
          {t("leave")}
        </Button>
      }
      title={t("leaveTitle", { org: orgName })}
      description={t("leaveBody", { org: orgName })}
      actions={
        <>
          <Button onClick={() => setOpen(false)}>{tm("cancel")}</Button>
          <Button type="submit" form={`leave-${orgId}`} variant="danger" loading={pending}>
            {t("leave")}
          </Button>
        </>
      }
    >
      <form id={`leave-${orgId}`} action={action}>
        <input type="hidden" name="orgId" value={orgId} />
        {state.error ? (
          <InlineAlert tone="danger">{t(`errors.${state.error}`, { org: orgName })}</InlineAlert>
        ) : null}
      </form>
    </Dialog>
  );
}
