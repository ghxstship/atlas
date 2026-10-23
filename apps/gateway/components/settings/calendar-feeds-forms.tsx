"use client";

import { Button, Dialog, InlineAlert, Input } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  addPersonFeedAction,
  revokePersonFeedAction,
  rotatePersonFeedAction,
  type PersonFeedFormState,
} from "@/lib/actions/calendar-feeds";

/**
 * Client forms of Gateway Settings, Calendar Feeds (ADR 0040): add a feed, get a new link and
 * revoke, confirming first where the old link stops. A new link is shown once with a copy button
 * and a webcal link that opens the device's calendar app.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Action = (state: PersonFeedFormState, form: FormData) => Promise<PersonFeedFormState>;

const INITIAL: PersonFeedFormState = {};

function useCopy(): Translate {
  const t = useTranslations("gateway.settings.calendarFeeds" as "gateway");
  return (key, values) => (t as unknown as Translate)(key, values);
}

function Failure({ state }: { state: PersonFeedFormState }) {
  const t = useCopy();
  return state.error ? <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert> : null;
}

function FeedLink({ link, id }: { link: string; id: string }) {
  const t = useCopy();
  const [copied, setCopied] = useState(false);
  return (
    <div
      role="status"
      className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
      data-testid="calendar-feed-link"
    >
      <p className="m-0 text-label-13 font-medium">{t("linkTitle")}</p>
      <p className="m-0 text-text-13 text-text-secondary">{t("linkHelp")}</p>
      <Input id={id} readOnly width="100%" label={t("linkLabel")} value={link} />
      <div className="flex flex-wrap items-center gap-12">
        <Button
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(link);
            setCopied(true);
          }}
        >
          {t("copy")}
        </Button>
        <a
          href={link.replace(/^https?:/, "webcal:")}
          className="text-text-13 text-accent-text underline"
        >
          {t("openInCalendar")}
        </a>
        {copied ? <span className="text-text-13 text-success-text">{t("copied")}</span> : null}
      </div>
    </div>
  );
}

export function AddPersonFeedForm() {
  const t = useCopy();
  const [state, dispatch, pending] = useActionState(addPersonFeedAction, INITIAL);
  return (
    <div className="flex flex-col gap-12">
      <form action={dispatch}>
        <Button type="submit" loading={pending}>
          {t("add")}
        </Button>
      </form>
      <Failure state={state} />
      {state.link ? <FeedLink id="calendar-feed-new-link" link={state.link} /> : null}
    </div>
  );
}

function ConfirmAction({
  id,
  label,
  ariaLabel,
  body,
  danger,
  action,
}: {
  id: string;
  label: string;
  ariaLabel: string;
  body: string;
  danger?: boolean;
  action: Action;
}) {
  const [state, dispatch, pending] = useActionState(action, INITIAL);
  // The dialog is open for the answer it was opened against: it stays open while the request
  // runs and closes on the next answer; a refusal then shows under the button.
  const [openedAt, setOpenedAt] = useState<PersonFeedFormState | null>(null);
  const open = openedAt === state;
  const setOpen = (next: boolean) => setOpenedAt(next ? state : null);
  const formId = `calendar-feed-${danger ? "revoke" : "rotate"}-${id}`;
  return (
    <div className="flex flex-col items-end gap-8">
      <Button
        size="sm"
        variant={danger ? "danger" : "ghost"}
        aria-label={ariaLabel}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      {open ? (
        <Dialog
          title={ariaLabel}
          open
          onOpenChange={setOpen}
          actions={
            <Button
              type="submit"
              form={formId}
              variant={danger ? "danger" : "primary"}
              loading={pending}
            >
              {label}
            </Button>
          }
        >
          <form id={formId} action={dispatch} className="flex flex-col gap-12">
            <input type="hidden" name="id" value={id} />
            <p className="m-0">{body}</p>
          </form>
        </Dialog>
      ) : null}
      {!open ? <Failure state={state} /> : null}
      {state.link ? <FeedLink id={`calendar-feed-link-${id}`} link={state.link} /> : null}
    </div>
  );
}

export function PersonFeedActions({ id, hint }: { id: string; hint: string }) {
  const t = useCopy();
  return (
    <div className="flex flex-wrap justify-end gap-8">
      <ConfirmAction
        id={id}
        label={t("rotate")}
        ariaLabel={t("rotateLabel", { hint })}
        body={t("rotateConfirm")}
        action={rotatePersonFeedAction}
      />
      <ConfirmAction
        id={id}
        label={t("revoke")}
        ariaLabel={t("revokeLabel", { hint })}
        body={t("revokeConfirm")}
        danger
        action={revokePersonFeedAction}
      />
    </div>
  );
}
