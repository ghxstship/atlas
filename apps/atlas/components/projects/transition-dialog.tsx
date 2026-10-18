"use client";

import { Button, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { transitionAction } from "@/lib/projects/actions";
import { ActionError, echoed, fieldError, useClosingAction } from "./action-error";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { DeferredDialog } from "@/components/lazy-ui/deferred";
/**
 * Moves a project or its production to another state through the lifecycle RPC (Section 3.12).
 * Only the moves the database's rule table allows from the current state are offered, and every
 * move carries a reason that lands in the ledger.
 */
export function TransitionDialog({
  org,
  projectKey,
  lifecycle,
  current,
  allowed,
}: {
  org: string;
  projectKey: string;
  lifecycle: "project" | "production";
  current: string;
  allowed: readonly string[];
}) {
  const t = useTranslations("projects");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useClosingAction(transitionAction, () => setOpen(false));
  const id = `transition-${lifecycle}`;
  if (allowed.length === 0) {
    return (
      <p className="m-0 text-text-12 text-text-secondary">
        {t("transition.none", { state: t(`states.${current}` as "states.Active") })}
      </p>
    );
  }
  return (
    <DeferredDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="secondary">
          {t("transition.action")}
        </Button>
      }
      title={
        lifecycle === "project" ? t("transition.projectTitle") : t("transition.productionTitle")
      }
      actions={
        <>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("transition.cancel")}
          </Button>
          <Button type="submit" form={id} variant="primary" loading={pending}>
            {t("transition.submit")}
          </Button>
        </>
      }
    >
      <form
        id={id}
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        className="flex flex-col gap-12"
        noValidate
      >
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="projectKey" value={projectKey} />
        <input type="hidden" name="lifecycle" value={lifecycle} />
        <ActionError state={state} />
        <Select
          id={`${id}-next`}
          name="next"
          label={t("transition.to")}
          value={allowed[0] ?? ""}
          options={allowed.map((s) => ({ value: s, label: t(`states.${s}` as "states.Active") }))}
        />
        <Textarea
          id={`${id}-reason`}
          name="reason"
          required
          maxLength={500}
          width="100%"
          defaultValue={echoed(state, "reason")}
          label={t("transition.reason")}
          help={t("transition.reasonHelp")}
          error={fieldError(t, state, "reason")}
        />
      </form>
    </DeferredDialog>
  );
}
