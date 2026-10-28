"use client";

import { Button, InlineAlert, Textarea } from "@xos/ui";
import type { LinkAction } from "@xos/data/notification-actions";
import Link from "next/link";
import type { Route } from "next";
import { useActionState, useRef } from "react";
import { confirmActionLink, type ActionLinkState } from "@/app/auth/act/[token]/actions";
import { useSecurityCopy, type SecurityCopy } from "./security/copy";
import { useStepUpForm } from "./security/step-up";

/** Rules whose sentence the page owns; any other refusal shows the database's own sentence. */
const STATE_RULES: Readonly<Record<string, string>> = {
  notification_action_used: "actionLink.state.used",
  notification_action_expired: "actionLink.state.expired",
  notification_action_not_yours: "actionLink.state.not_yours",
  notification_action_invalid: "actionLink.state.invalid",
  notification_action_reason: "actionLink.errors.notification_action_reason",
  unexpected: "actionLink.errors.unexpected",
};

function errorSentence(t: SecurityCopy, state: ActionLinkState): string | null {
  if (!state.rule || state.rule === "step_up_required") return null;
  const key = STATE_RULES[state.rule];
  return key ? t(key) : (state.message ?? t("actionLink.errors.unexpected"));
}

/**
 * The confirm step of a one-tap email link (A127, ADR 0086): one button for Approve or Accept, the reason and Reject
 * for a rejection. A step-up refusal opens the step-up dialog and verifying confirms again. Works before hydration.
 */
export function ActionLinkForm({
  token,
  action,
  inboxHref,
}: {
  token: string;
  action: LinkAction;
  inboxHref: string;
}) {
  const t = useSecurityCopy();
  const [state, confirm, pending] = useActionState<ActionLinkState, FormData>(
    confirmActionLink,
    {},
  );
  const form = useRef<HTMLFormElement>(null);
  const stepUp = useStepUpForm(state, (s) => s.rule === "step_up_required", form);
  if (state.done) {
    return (
      <div className="flex flex-col gap-12">
        <InlineAlert tone="success">{t(`actionLink.done.${state.done}`)}</InlineAlert>
        <Link href={inboxHref as Route} className="text-text-14 text-accent-text underline">
          {t("actionLink.openInbox")}
        </Link>
      </div>
    );
  }
  const error = errorSentence(t, state);
  return (
    <div className="flex flex-col gap-12">
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <form ref={form} action={confirm} className="flex flex-col gap-12">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="action" value={action} />
        {action === "reject" ? (
          <Textarea
            name="reason"
            label={t("actionLink.reason")}
            help={t("actionLink.reasonHelp")}
            required
            maxLength={2000}
            rows={3}
          />
        ) : null}
        <div className="flex flex-wrap items-center gap-12">
          <Button
            type="submit"
            variant={action === "reject" ? "danger" : "primary"}
            loading={pending}
          >
            {t(`actionLink.confirm.${action}`)}
          </Button>
          <Link href={inboxHref as Route} className="text-text-14 text-accent-text underline">
            {t("actionLink.openInbox")}
          </Link>
        </div>
      </form>
      {stepUp}
    </div>
  );
}
