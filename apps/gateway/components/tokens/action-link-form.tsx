"use client";

import { Button, InlineAlert, Textarea, buttonClass } from "@xos/ui";
import type { LinkAction } from "@xos/data/notification-actions";
import type { Route } from "next";
import NextLink from "next/link";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { OutcomeAlert } from "@/components/actions/action-button";
import { keepInputOnSubmit } from "@/components/forms/keep-input";
import { confirmActionLinkAction, type ActionLinkState } from "@/lib/actions/one-tap";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The confirm step of a one-tap email link in Gateway (A127, ADR 0106): one button to accept, or the reason and Reject.
 * A refusal keeps the typed reason. Works before hydration.
 */
export function ActionLinkForm({ token, action }: { token: string; action: LinkAction }) {
  const t = useTranslations("gateway.auth.actionLink") as unknown as Translate;
  const [state, confirm, pending] = useActionState<ActionLinkState, FormData>(
    confirmActionLinkAction,
    {},
  );
  if (state.done) {
    return (
      <div className="flex flex-col gap-12">
        <InlineAlert tone="success">{t(`done.${state.done}`)}</InlineAlert>
        <NextLink href={"/home" as Route} className={buttonClass("primary", "md")}>
          {t("home")}
        </NextLink>
      </div>
    );
  }
  return (
    <form action={confirm} onSubmit={keepInputOnSubmit(confirm)} className="flex flex-col gap-12">
      <OutcomeAlert outcome={state.outcome} />
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="action" value={action} />
      {action === "reject" ? (
        <Textarea name="reason" label={t("reason")} required maxLength={2000} rows={3} />
      ) : null}
      <div className="flex flex-wrap items-center gap-12">
        <Button
          type="submit"
          variant={action === "reject" ? "danger" : "primary"}
          disabled={pending}
          aria-busy={pending}
        >
          {t(`confirm.${action}`)}
        </Button>
        <NextLink href={"/home" as Route} className="text-text-14 text-accent-text underline">
          {t("home")}
        </NextLink>
      </div>
    </form>
  );
}
