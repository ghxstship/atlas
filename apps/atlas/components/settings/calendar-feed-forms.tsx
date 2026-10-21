"use client";

import { Button, Dialog, InlineAlert, Input, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  addCalendarFeedAction,
  revokeCalendarFeedAction,
  rotateCalendarFeedAction,
  type CalendarFeedFormState,
} from "@/app/[org]/me/calendar-feed-actions";
import { useKeepInput } from "@/components/collection-kit/keep-input";

/**
 * Client forms of Personal settings, Calendar Feeds (ADR 0040): add a feed, get a new link and
 * revoke, each confirming first where the old link stops. A new link is shown once with a copy
 * button and a webcal link that opens the device's calendar app. None uses the primary button
 * outside a dialog (gate 27).
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Option = { readonly value: string; readonly label: string };

const INITIAL: CalendarFeedFormState = {};

function useCopy(): Translate {
  const t = useTranslations("platform.calendarFeeds" as "platform");
  return (key, values) => (t as unknown as Translate)(key, values);
}

function Failure({ state }: { state: CalendarFeedFormState }) {
  const t = useCopy();
  return state.error ? <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert> : null;
}

/** A subscription link shown once: read-only field, copy button and a webcal link. */
export function FeedLink({ link, id }: { link: string; id: string }) {
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

export function AddCalendarFeedForm({
  org,
  projects,
}: {
  org: string;
  projects: readonly Option[];
}) {
  const t = useCopy();
  const [state, dispatch, pending] = useActionState(addCalendarFeedAction, INITIAL);
  const keep = useKeepInput(state, dispatch, (s) => s.ok === true);
  return (
    <div className="flex flex-col gap-12">
      <form
        action={dispatch}
        {...keep}
        aria-label={t("addTitle")}
        className="flex flex-wrap items-end gap-12"
        noValidate
      >
        <input type="hidden" name="org" value={org} />
        <Select
          id="calendar-feed-scope"
          name="scope"
          label={t("scopeLabel")}
          help={t("projectHelp")}
          value="mine"
          options={[{ value: "mine", label: t("scopeMine") }, ...projects]}
        />
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
  org,
  id,
  label,
  ariaLabel,
  title,
  body,
  danger,
  action,
}: {
  org: string;
  id: string;
  label: string;
  ariaLabel: string;
  title: string;
  body: string;
  danger?: boolean;
  action: (state: CalendarFeedFormState, form: FormData) => Promise<CalendarFeedFormState>;
}) {
  const t = useCopy();
  const [state, dispatch, pending] = useActionState(action, INITIAL);
  // The dialog is open for the answer it was opened against: it stays open while the request
  // runs and closes on the next answer; a refusal then shows under the button.
  const [openedAt, setOpenedAt] = useState<CalendarFeedFormState | null>(null);
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
          title={title}
          open
          onOpenChange={setOpen}
          actions={
            <>
              <Button type="button" onClick={() => setOpen(false)}>
                {t("cancel")}
              </Button>
              <Button
                type="submit"
                form={formId}
                variant={danger ? "danger" : "primary"}
                loading={pending}
              >
                {label}
              </Button>
            </>
          }
        >
          <form id={formId} action={dispatch} className="flex flex-col gap-12">
            <input type="hidden" name="org" value={org} />
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

export function CalendarFeedActions({ org, id, name }: { org: string; id: string; name: string }) {
  const t = useCopy();
  return (
    <div className="flex flex-wrap justify-end gap-8">
      <ConfirmAction
        org={org}
        id={id}
        label={t("rotate")}
        ariaLabel={t("rotateLabel", { feed: name })}
        title={t("rotateTitle")}
        body={t("rotateBody")}
        action={rotateCalendarFeedAction}
      />
      <ConfirmAction
        org={org}
        id={id}
        label={t("revoke")}
        ariaLabel={t("revokeLabel", { feed: name })}
        title={t("revokeTitle")}
        body={t("revokeBody")}
        danger
        action={revokeCalendarFeedAction}
      />
    </div>
  );
}
