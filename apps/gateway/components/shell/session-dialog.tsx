"use client";

import { Button, Dialog, InlineAlert, Input } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { reauthenticate, type FormState } from "@/app/auth/actions";
import { keepInputOnSubmit } from "@/components/forms/keep-input";

/**
 * The sign-in dialog the session watcher opens over the page when the session is gone (Section
 * 11.7). It loads only then (A24-009), so the Radix dialog stays out of every page's JavaScript.
 */
export function SessionDialog({
  email,
  onSignedIn,
}: {
  email: string | null;
  onSignedIn: () => void;
}) {
  const t = useTranslations("gateway.auth");
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, form) => {
    const result = await reauthenticate(prev, form);
    if (result.ok) onSignedIn();
    return result;
  }, {});

  return (
    <Dialog
      open
      onOpenChange={() => undefined}
      title={t("session.expiredTitle")}
      description={t("session.expiredBody")}
      actions={
        <Button type="submit" form="session-reauth" variant="primary" loading={pending}>
          {t("session.submit")}
        </Button>
      }
    >
      <form
        id="session-reauth"
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        className="flex flex-col gap-12"
        noValidate
      >
        {state.error ? (
          <InlineAlert tone="danger">
            {t(`errors.${state.error}` as "errors.unexpected")}
          </InlineAlert>
        ) : null}
        <Input
          id="session-email"
          name="email"
          type="email"
          autoComplete="email"
          width="100%"
          label={t("fields.email")}
          defaultValue={state.values?.["email"] ?? email ?? ""}
        />
        <Input
          id="session-password"
          name="password"
          type="password"
          autoComplete="current-password"
          width="100%"
          label={t("fields.password")}
        />
      </form>
    </Dialog>
  );
}
