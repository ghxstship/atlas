"use client";

import { Button, Checkbox, InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { subscribeAccountAction, type SubscribeState } from "@/app/auth/subscribe-actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";

type Doc = { href: string; title: string };

/**
 * Journey 60 on the organization step: each company account the person owns in Gateway, offered to
 * start Atlas as the same organization. The Owner accepts the same documents as on create.
 */
export function SubscribeAccounts({
  accounts,
  terms,
  dpa,
}: {
  accounts: readonly { id: string; name: string; slug: string }[];
  terms: Doc;
  dpa: Doc;
}) {
  const t = useTranslations("subscribeAccount");
  if (accounts.length === 0) return null;
  return (
    <section aria-labelledby="subscribe-title" className="flex flex-col gap-12">
      <div className="flex flex-col gap-4">
        <h2 id="subscribe-title" className="m-0 text-heading-16 font-semibold">
          {t("title")}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">{t("lead")}</p>
      </div>
      {accounts.map((a) => (
        <SubscribeForm key={a.id} account={a} terms={terms} dpa={dpa} />
      ))}
      <h2 className="m-0 text-heading-16 font-semibold">{t("or")}</h2>
    </section>
  );
}

const INITIAL: SubscribeState = {};

function SubscribeForm({
  account,
  terms,
  dpa,
}: {
  account: { id: string; name: string; slug: string };
  terms: Doc;
  dpa: Doc;
}) {
  const t = useTranslations("subscribeAccount");
  const tr = useTranslations("shell.auth.organization");
  const [state, action, pending] = useActionState(subscribeAccountAction, INITIAL);
  const acceptId = `subscribe-accept-${account.id}`;
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      aria-label={t("use", { name: account.name })}
      className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
      noValidate
    >
      <input type="hidden" name="accountId" value={account.id} />
      <input type="hidden" name="slug" value={account.slug} />
      {state.error && state.error !== "accept" ? (
        <InlineAlert tone="danger">{t(state.error)}</InlineAlert>
      ) : null}
      <Checkbox
        id={acceptId}
        name="accept"
        required
        aria-invalid={state.error === "accept" ? true : undefined}
        aria-describedby={state.error === "accept" ? `${acceptId}-error` : undefined}
        label={
          <span className="text-text-13 text-text-secondary">
            {tr.rich("accept", {
              terms: terms.title,
              dpa: dpa.title,
              termsLink: (chunks) => (
                <a className="text-accent-text underline" href={terms.href} target="_blank">
                  {chunks}
                </a>
              ),
              dpaLink: (chunks) => (
                <a className="text-accent-text underline" href={dpa.href} target="_blank">
                  {chunks}
                </a>
              ),
            })}
          </span>
        }
      />
      {state.error === "accept" ? (
        <p id={`${acceptId}-error`} className="m-0 text-text-12 text-danger-text">
          {t("acceptError")}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {t("use", { name: account.name })}
        </Button>
      </div>
    </form>
  );
}
