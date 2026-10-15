"use client";

import { Button, InlineAlert, buttonClass } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { OutcomeAlert } from "@/components/actions/action-button";
import { claimAction, type ClaimState } from "@/lib/actions/claim";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Claims token submissions into the signed-in account, then points Home. */
export function ClaimForm({ email }: { email: string }) {
  const t = useTranslations("gateway.auth.claim") as unknown as Translate;
  const [state, action, pending] = useActionState<ClaimState, FormData>(claimAction, {});
  if (state.claimed) {
    return (
      <div className="flex flex-col gap-12">
        <InlineAlert tone="success">
          {state.claimed.advance + state.claimed.documents > 0
            ? t("done", { advance: state.claimed.advance, documents: state.claimed.documents })
            : t("nothing", { email })}
        </InlineAlert>
        <NextLink href={"/home" as Route} className={buttonClass("primary", "md")}>
          {t("home")}
        </NextLink>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-12">
      <OutcomeAlert outcome={state.outcome} />
      <div>
        <Button type="submit" variant="primary" disabled={pending} aria-busy={pending}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}
