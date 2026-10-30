"use client";

import { Button, Checkbox, Dialog, InlineAlert, Input, MultiSelect, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  addCalendarFeedAction,
  configureCalendarFeedAction,
  revokeCalendarFeedAction,
  rotateCalendarFeedAction,
  type CalendarFeedFormState,
} from "@/app/[org]/me/calendar-feed-actions";
import { useKeepInput } from "@/components/collection-kit/keep-input";

/**
 * Client forms of Personal settings, Calendar Feeds (ADR 0040): add a feed, edit it, get a new
 * link and revoke, each confirming first where the old link stops. A new link is shown once with a
 * copy button and a webcal link that opens the device's calendar app. A feed has a name and content
 * and, on a project feed, an audience and a show department (B7, ADR 0146). None uses the primary
 * button outside a dialog (gate 27).
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Option = { readonly value: string; readonly label: string };

const SOURCES = ["Shifts", "Meetings", "Milestones", "Deadlines", "Cues"] as const;
const DEFAULT_SOURCES = ["Shifts", "Meetings", "Milestones", "Deadlines"];

/** What the audience and show department pickers offer (people, teams, departments, departments of a show). */
export interface FeedPickers {
  readonly people: readonly Option[];
  readonly teams: readonly Option[];
  readonly departments: readonly Option[];
  readonly callKinds: readonly Option[];
}

/** A feed's saved configuration, as the edit form opens it. */
export interface FeedValues {
  readonly name: string | null;
  readonly sources: readonly string[] | null;
  readonly audience:
    | { readonly kind: "people"; readonly personIds: readonly string[] }
    | { readonly kind: "team"; readonly teamId: string }
    | { readonly kind: "department"; readonly departmentCode: string }
    | null;
  readonly cueCallKind: string | null;
}

const EMPTY_VALUES: FeedValues = { name: null, sources: null, audience: null, cueCallKind: null };

/** The name, content, audience and show department fields shared by Add and Edit. */
function FeedFields({
  idPrefix,
  projectFeed,
  values,
  pickers,
}: {
  idPrefix: string;
  projectFeed: boolean;
  values: FeedValues;
  pickers: FeedPickers;
}) {
  const t = useCopy();
  const [kind, setKind] = useState<string>(values.audience?.kind ?? "everyone");
  const [people, setPeople] = useState<string[]>(
    values.audience?.kind === "people" ? [...values.audience.personIds] : [],
  );
  const sources = values.sources ?? DEFAULT_SOURCES;
  return (
    <>
      <Input
        id={`${idPrefix}-name`}
        name="name"
        label={t("nameLabel")}
        help={t("nameHelp")}
        maxLength={80}
        defaultValue={values.name ?? ""}
      />
      <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
        <legend className="mb-4 text-label-13 font-medium">{t("contentLabel")}</legend>
        {SOURCES.filter((s) => projectFeed || s !== "Cues").map((s) => (
          <Checkbox
            key={s}
            name="sources"
            value={s}
            defaultChecked={sources.includes(s)}
            label={t(`sources.${s.toLowerCase()}`)}
          />
        ))}
      </fieldset>
      {projectFeed ? (
        <>
          <Select
            id={`${idPrefix}-audience`}
            name="audienceKind"
            label={t("audienceLabel")}
            help={t("audienceHelp")}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            options={(["everyone", "people", "team", "department"] as const).map((k) => ({
              value: k,
              label: t(`audience.${k}`),
            }))}
          />
          {kind === "people" ? (
            <>
              <MultiSelect
                id={`${idPrefix}-people`}
                label={t("peopleLabel")}
                help={t("peopleHelp")}
                value={people}
                options={[...pickers.people]}
                onChange={setPeople}
              />
              {people.map((p) => (
                <input key={p} type="hidden" name="personIds" value={p} />
              ))}
            </>
          ) : null}
          {kind === "team" ? (
            <Select
              id={`${idPrefix}-team`}
              name="teamId"
              label={t("teamLabel")}
              value={
                values.audience?.kind === "team"
                  ? values.audience.teamId
                  : (pickers.teams[0]?.value ?? "")
              }
              options={[...pickers.teams]}
            />
          ) : null}
          {kind === "department" ? (
            <Select
              id={`${idPrefix}-department`}
              name="departmentCode"
              label={t("departmentLabel")}
              value={
                values.audience?.kind === "department"
                  ? values.audience.departmentCode
                  : (pickers.departments[0]?.value ?? "")
              }
              options={[...pickers.departments]}
            />
          ) : null}
          <Select
            id={`${idPrefix}-call-kind`}
            name="cueCallKind"
            label={t("showDepartmentLabel")}
            help={t("showDepartmentHelp")}
            value={values.cueCallKind ?? "any"}
            options={[{ value: "any", label: t("showDepartmentAny") }, ...pickers.callKinds]}
          />
        </>
      ) : null}
    </>
  );
}

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
  pickers,
}: {
  org: string;
  projects: readonly Option[];
  pickers: FeedPickers;
}) {
  const t = useCopy();
  const [state, dispatch, pending] = useActionState(addCalendarFeedAction, INITIAL);
  const keep = useKeepInput(state, dispatch, (s) => s.ok === true);
  const [scope, setScope] = useState("mine");
  return (
    <div className="flex flex-col gap-12">
      <form
        action={dispatch}
        {...keep}
        aria-label={t("addTitle")}
        className="flex flex-col gap-12"
        noValidate
      >
        <input type="hidden" name="org" value={org} />
        <Select
          id="calendar-feed-scope"
          name="scope"
          label={t("scopeLabel")}
          help={t("projectHelp")}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          options={[{ value: "mine", label: t("scopeMine") }, ...projects]}
        />
        <FeedFields
          key={scope === "mine" ? "mine" : "project"}
          idPrefix="calendar-feed-new"
          projectFeed={scope !== "mine"}
          values={EMPTY_VALUES}
          pickers={pickers}
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

/** Edit: the same fields as Add, saved with configureCalendarFeedAction; the link stays. */
function EditFeed({
  org,
  id,
  name,
  projectFeed,
  values,
  pickers,
}: {
  org: string;
  id: string;
  name: string;
  projectFeed: boolean;
  values: FeedValues;
  pickers: FeedPickers;
}) {
  const t = useCopy();
  const [state, dispatch, pending] = useActionState(configureCalendarFeedAction, INITIAL);
  const [openedAt, setOpenedAt] = useState<CalendarFeedFormState | null>(null);
  const open = openedAt === state;
  const setOpen = (next: boolean) => setOpenedAt(next ? state : null);
  const formId = `calendar-feed-edit-${id}`;
  return (
    <div className="flex flex-col items-end gap-8">
      <Button
        size="sm"
        variant="ghost"
        aria-label={t("editLabel", { feed: name })}
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
            <>
              <Button type="button" onClick={() => setOpen(false)}>
                {t("cancel")}
              </Button>
              <Button type="submit" form={formId} variant="primary" loading={pending}>
                {t("save")}
              </Button>
            </>
          }
        >
          <form id={formId} action={dispatch} className="flex flex-col gap-12" noValidate>
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="projectFeed" value={projectFeed ? "true" : "false"} />
            <FeedFields
              idPrefix={formId}
              projectFeed={projectFeed}
              values={values}
              pickers={pickers}
            />
          </form>
        </Dialog>
      ) : null}
      {!open ? <Failure state={state} /> : null}
    </div>
  );
}

export function CalendarFeedActions({
  org,
  id,
  name,
  projectFeed,
  values,
  pickers,
}: {
  org: string;
  id: string;
  name: string;
  projectFeed: boolean;
  values: FeedValues;
  pickers: FeedPickers;
}) {
  const t = useCopy();
  return (
    <div className="flex flex-wrap justify-end gap-8">
      <EditFeed
        org={org}
        id={id}
        name={name}
        projectFeed={projectFeed}
        values={values}
        pickers={pickers}
      />
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
