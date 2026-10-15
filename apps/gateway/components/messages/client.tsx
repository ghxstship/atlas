"use client";

import { Button, InlineAlert, Input, Textarea } from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect } from "react";
import { OutcomeAlert } from "@/components/actions/action-button";
import {
  markReadAction,
  startPartyThreadAction,
  type StartThreadState,
} from "@/lib/actions/messages";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Marks the open thread read once it renders (read receipts, Section 11.12 Communicate). */
export function MarkRead({ kind, threadId }: { kind: "engagement" | "party"; threadId: string }) {
  useEffect(() => {
    void markReadAction(kind, threadId);
  }, [kind, threadId]);
  return null;
}

/** Starts a conversation with an org the person works with (A28b app.start_party_thread). */
export function StartConversationForm({ orgs }: { orgs: readonly { id: string; name: string }[] }) {
  const t = useTranslations("gateway.messages.start") as unknown as Translate;
  const router = useRouter();
  const [state, action, pending] = useActionState<StartThreadState, FormData>(
    startPartyThreadAction,
    {},
  );
  useEffect(() => {
    if (state.threadKey) router.push(`/messages/${state.threadKey}` as Route);
  }, [state.threadKey, router]);
  if (orgs.length === 0)
    return <p className="m-0 text-text-13 text-text-secondary">{t("noOrgs")}</p>;
  return (
    <form action={action} className="flex flex-col gap-12" aria-label={t("title")}>
      {state.fieldError ? <InlineAlert tone="danger">{t("error")}</InlineAlert> : null}
      <OutcomeAlert outcome={state.outcome} />
      <label className="flex flex-col gap-4 text-text-13">
        <span className="font-medium">{t("org")}</span>
        <select
          name="orgId"
          required
          className="min-h-touch-min rounded-control border border-border-control bg-bg-surface px-8 text-text-14 text-text-primary"
        >
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      <Input id="start-subject" name="subject" required label={t("subject")} width="100%" />
      <Textarea id="start-body" name="body" required rows={3} width="100%" label={t("body")} />
      <div>
        <Button type="submit" variant="primary" icon="Send" disabled={pending} aria-busy={pending}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}
