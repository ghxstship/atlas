"use client";

import { Button, Dialog, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  sendAgreementAction,
  signAgreementAction,
  type PeopleActionState,
} from "@/app/[org]/people/actions";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
/**
 * Sends an agreement for signature and shows its signing link and access code once (invariant 8):
 * they are stored only as hashes, so this dialog is the only place they ever appear. The signer gets
 * the link and the code through separate channels and signs in Gateway without an account (journey 9).
 */
export function SendAgreementButton(props: { org: string; id: string }) {
  const t = useTranslations("people.agreements");
  const form = useTranslations("crew.form");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // The page refreshes only once the dialog closes: the refreshed record no longer offers Send, and
  // the link and code must stay on screen until the person has copied them.
  const [state, action, pending] = useActionState(sendAgreementAction, {});
  const close = (next: boolean) => {
    setOpen(next);
    if (!next && state.signing) router.refresh();
  };
  return (
    <>
      <Button type="button" size="sm" variant="primary" onClick={() => setOpen(true)}>
        {t("send")}
      </Button>
      {open ? (
        <Dialog
          title={state.signing ? t("sentTitle") : t("sendTitle")}
          open
          onOpenChange={close}
          actions={
            state.signing ? (
              <Button type="button" variant="primary" onClick={() => close(false)}>
                {t("done")}
              </Button>
            ) : (
              <>
                <Button type="button" variant="ghost" onClick={() => close(false)}>
                  {form("cancel")}
                </Button>
                <Button type="submit" form={`send-${props.id}`} variant="primary" loading={pending}>
                  {t("send")}
                </Button>
              </>
            )
          }
        >
          {state.signing ? (
            <div className="flex flex-col gap-12">
              <InlineAlert tone="warning" title={t("onceTitle")}>
                {t("onceBody")}
              </InlineAlert>
              <Input
                id={`link-${props.id}`}
                readOnly
                width="100%"
                label={t("link")}
                value={state.signing.link}
              />
              <Input
                id={`code-${props.id}`}
                readOnly
                width="100%"
                label={t("code")}
                value={state.signing.accessCode}
              />
            </div>
          ) : (
            <form
              id={`send-${props.id}`}
              action={action}
              onSubmit={keepInputOnSubmit(action)}
              className="flex flex-col gap-12"
            >
              <input type="hidden" name="org" value={props.org} />
              <input type="hidden" name="id" value={props.id} />
              {state.error ? (
                <InlineAlert tone="danger" title={form("refused")}>
                  {state.error}
                </InlineAlert>
              ) : null}
              <Select
                id={`days-${props.id}`}
                name="days"
                label={t("validFor")}
                value="14"
                options={[1, 7, 14, 30, 90].map((d) => ({
                  value: String(d),
                  label: t("days", { count: d }),
                }))}
              />
              <Textarea
                id={`reason-${props.id}`}
                name="reason"
                label={form("reason")}
                defaultValue={t("sendReason")}
                width="100%"
              />
            </form>
          )}
        </Dialog>
      ) : null}
    </>
  );
}

/** The named signer signs while signed in, typing their name over the exact text shown. */
export function SignAgreementForm(props: { org: string; id: string }) {
  const t = useTranslations("people.agreements");
  const form = useTranslations("crew.form");
  const router = useRouter();
  const [state, action, pending] = useActionState(
    async (prev: PeopleActionState, data: FormData) => {
      const next = await signAgreementAction(prev, data);
      if (next.ok) router.refresh();
      return next;
    },
    {},
  );
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
    >
      <input type="hidden" name="org" value={props.org} />
      <input type="hidden" name="id" value={props.id} />
      <p className="m-0 text-text-12 text-text-secondary">{t("signHelp")}</p>
      {state.error ? (
        <InlineAlert tone="danger" title={form("refused")}>
          {state.error}
        </InlineAlert>
      ) : null}
      <Input
        id={`sign-${props.id}`}
        name="signedName"
        label={t("signedName")}
        required
        width="100%"
      />
      <div>
        <Button type="submit" variant="primary" size="sm" loading={pending}>
          {t("sign")}
        </Button>
      </div>
    </form>
  );
}
