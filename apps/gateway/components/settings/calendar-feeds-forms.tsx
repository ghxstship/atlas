"use client";

import { Button, Checkbox, Dialog, InlineAlert, Input } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  addPersonFeedAction,
  configurePersonFeedAction,
  revokePersonFeedAction,
  rotatePersonFeedAction,
  type PersonFeedFormState,
} from "@/lib/actions/calendar-feeds";

/**
 * Client forms of Gateway Settings, Calendar Feeds (ADR 0040): add a feed, edit its name and
 * content (B7, ADR 0146), get a new link and revoke, confirming first where the old link stops. A
 * new link is shown once with a copy button and a webcal link that opens the device's calendar app.
 */

const SOURCES = ["Shifts", "Meetings", "Milestones", "Deadlines", "Cues"] as const;
const DEFAULT_SOURCES = ["Shifts", "Meetings", "Milestones", "Deadlines"];

/** A feed's name and content fields, shared by Add and Edit. */
function FeedFields({
  idPrefix,
  name,
  sources,
}: {
  idPrefix: string;
  name: string | null;
  sources: readonly string[] | null;
}) {
  const t = useCopy();
  const checked = sources ?? DEFAULT_SOURCES;
  return (
    <>
      <Input
        id={`${idPrefix}-name`}
        name="name"
        label={t("nameLabel")}
        help={t("nameHelp")}
        maxLength={80}
        defaultValue={name ?? ""}
      />
      <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
        <legend className="mb-4 text-label-13 font-medium">{t("contentLabel")}</legend>
        {SOURCES.map((s) => (
          <Checkbox
            key={s}
            name="sources"
            value={s}
            defaultChecked={checked.includes(s)}
            label={t(`sources.${s.toLowerCase()}`)}
          />
        ))}
      </fieldset>
    </>
  );
}

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
      <form action={dispatch} aria-label={t("add")} className="flex flex-col gap-12" noValidate>
        <FeedFields idPrefix="calendar-feed-new" name={null} sources={null} />
        <div>
          <Button type="submit" loading={pending}>
            {t("add")}
          </Button>
        </div>
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

/** Edit: the feed's name and content, saved with configurePersonFeedAction; the link stays. */
function EditFeed({
  id,
  hint,
  name,
  sources,
}: {
  id: string;
  hint: string;
  name: string | null;
  sources: readonly string[] | null;
}) {
  const t = useCopy();
  const [state, dispatch, pending] = useActionState(configurePersonFeedAction, INITIAL);
  const [openedAt, setOpenedAt] = useState<PersonFeedFormState | null>(null);
  const open = openedAt === state;
  const setOpen = (next: boolean) => setOpenedAt(next ? state : null);
  const formId = `calendar-feed-edit-${id}`;
  return (
    <div className="flex flex-col items-end gap-8">
      <Button
        size="sm"
        variant="ghost"
        aria-label={t("editLabel", { hint })}
        onClick={() => setOpen(true)}
      >
        {t("edit")}
      </Button>
      {open ? (
        <Dialog
          title={t("editTitle")}
          open
          onOpenChange={setOpen}
          actions={
            <Button type="submit" form={formId} variant="primary" loading={pending}>
              {t("save")}
            </Button>
          }
        >
          <form id={formId} action={dispatch} className="flex flex-col gap-12" noValidate>
            <input type="hidden" name="id" value={id} />
            <FeedFields idPrefix={formId} name={name} sources={sources} />
          </form>
        </Dialog>
      ) : null}
      {!open ? <Failure state={state} /> : null}
    </div>
  );
}

export function PersonFeedActions({
  id,
  hint,
  name = null,
  sources = null,
}: {
  id: string;
  hint: string;
  name?: string | null;
  sources?: readonly string[] | null;
}) {
  const t = useCopy();
  return (
    <div className="flex flex-wrap justify-end gap-8">
      <EditFeed id={id} hint={hint} name={name} sources={sources} />
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
