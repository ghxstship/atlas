"use client";

import { Button, InlineAlert, Input } from "@xos/ui";
import { useActionState } from "react";
import { useKeepInput } from "@/components/collection-kit/keep-input";
import {
  subscribeSubprocessorAction,
  type SubscribeState,
} from "@/lib/privacy/subprocessor-actions";

/**
 * The Subprocessor List change notice subscription form (Section 14.4, migration 1382). It still posts
 * without JavaScript; with it, a refused address keeps what was typed and the answer appears in place.
 * Copy comes translated from the page, which renders on the server.
 */
export function SubprocessorSubscribeForm({
  labels,
  notices,
}: {
  labels: { email: string; emailHelp: string; subscribe: string };
  notices: Readonly<Record<NonNullable<SubscribeState["notice"]>, string>>;
}) {
  const [state, action, pending] = useActionState(subscribeSubprocessorAction, {});
  const keep = useKeepInput(state, action, (s) => s.notice === "subscribed");
  return (
    <form action={action} {...keep} className="flex flex-col gap-12">
      {state.notice ? (
        <InlineAlert tone={state.notice === "subscribed" ? "success" : "danger"}>
          {notices[state.notice]}
        </InlineAlert>
      ) : null}
      <Input
        id="subprocessor-email"
        name="email"
        type="email"
        autoComplete="email"
        required
        maxLength={320}
        label={labels.email}
        help={labels.emailHelp}
        width="100%"
      />
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {labels.subscribe}
        </Button>
      </div>
    </form>
  );
}
