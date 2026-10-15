"use client";

import { Button, Dialog, IconButton, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import type { RiderLineProposal } from "@xos/data/advancing";
import type { Route } from "next";
import { useFormatter } from "next-intl";
import { useRouter } from "next/navigation";
import {
  startTransition,
  useActionState,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  addRecipientAction,
  addRiderLineAction,
  addSectionAction,
  archivePacketAction,
  archiveRiderAction,
  createPacketAction,
  createRiderAction,
  issueLinkAction,
  moveSectionAction,
  recordSubmissionAction,
  removeRecipientAction,
  removeRiderLineAction,
  removeSectionAction,
  revokeLinkAction,
  reviewSubmissionAction,
  runReconciliationAction,
  sendPacketAction,
  toggleRiderLineAction,
  updatePacketAction,
  updateRiderAction,
  updateRiderLineAction,
  updateSectionAction,
  type AdvancingState,
} from "./actions";
import { useCopy } from "./use-copy";
import { useQueryHref } from "./views";

/** Client forms of the Advancing pages; each keeps typed input after a failed submit. */

/**
 * Submits a form to a server action in a transition instead of through the form action, so a
 * refused submit keeps what the person typed (React resets a form after a form action). The
 * submitter is included, so a button's name and value reach the action.
 */
function submitWith(run: (form: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const data = new FormData(event.currentTarget, submitter);
    startTransition(() => run(data));
  };
}

const INITIAL: AdvancingState = {};

type Action = (state: AdvancingState, form: FormData) => Promise<AdvancingState>;

export interface Option {
  readonly value: string;
  readonly label: string;
}

function ErrorNotice({ state }: { state: AdvancingState }) {
  const t = useCopy("advancing.errors");
  return state.error ? (
    <InlineAlert tone="danger" title={t("title")}>
      {t(state.error)}
    </InlineAlert>
  ) : null;
}

/** The browser's UTC offset as +HH:MM, so a `datetime-local` value is read in the viewer's zone. */
function browserOffset(): string {
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

const noSubscription = () => () => undefined;

function TzOffset() {
  const offset = useSyncExternalStore(noSubscription, browserOffset, () => "");
  return <input type="hidden" name="tzOffset" value={offset} />;
}

/**
 * An action whose form clears after each success: `resetKey` changes only when the action
 * succeeds, so a form keyed by it remounts empty while a failed submit keeps the typed input.
 */
type Sequenced = AdvancingState & { readonly seq?: number };

function useResettingAction(action: Action) {
  const [state, formAction, pending] = useActionState<Sequenced, FormData>(async (prev, form) => {
    const next = await action(prev, form);
    return { ...next, seq: (prev.seq ?? 0) + (next.ok ? 1 : 0) };
  }, INITIAL);
  return [state, formAction, pending, state.seq ?? 0] as const;
}

/** `datetime-local` value of an ISO time in the browser's zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A one-button form: the button posts the hidden fields to the action. */
function ActButton({
  action,
  fields,
  label,
  variant = "secondary",
  icon,
  iconOnly = false,
  confirm,
}: {
  action: Action;
  fields: Readonly<Record<string, string>>;
  label: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: string;
  iconOnly?: boolean;
  /** When set, the act asks first in a dialog with this title and sentence. */
  confirm?: { title: string; sentence: string; actionLabel: string };
}) {
  const t = useCopy("advancing.common");
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const [open, setOpen] = useState(false);
  const formId = useId();
  const hidden = Object.entries(fields).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ));
  const trigger = iconOnly ? (
    <IconButton icon={icon ?? "Circle"} label={label} type={confirm ? "button" : "submit"} />
  ) : (
    <Button
      variant={variant}
      size="sm"
      loading={pending}
      type={confirm ? "button" : "submit"}
      {...(icon ? { icon } : {})}
    >
      {label}
    </Button>
  );
  return (
    <form id={formId} onSubmit={submitWith(formAction)} className="inline-flex flex-col gap-8">
      {hidden}
      {confirm ? (
        <Dialog
          title={confirm.title}
          open={open}
          onOpenChange={setOpen}
          trigger={trigger}
          actions={
            <>
              <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
                {t("cancel")}
              </Button>
              <Button
                variant={variant === "danger" ? "danger" : "primary"}
                type="submit"
                form={formId}
                loading={pending}
                onClick={() => setOpen(false)}
              >
                {confirm.actionLabel}
              </Button>
            </>
          }
        >
          <p className="m-0">{confirm.sentence}</p>
        </Dialog>
      ) : (
        trigger
      )}
      <ErrorNotice state={state} />
    </form>
  );
}

// Packets -------------------------------------------------------------------------------------------

/** New packet, opened by the primary action or `?create=1` (ADR 0017 item 4). */
export function CreatePacketDialog({
  org,
  projects,
  defaultProjectId,
  defaultOpen,
}: {
  org: string;
  projects: readonly Option[];
  defaultProjectId: string | null;
  defaultOpen: boolean;
}) {
  const t = useCopy("advancing.packets.create");
  const common = useCopy("advancing.common");
  const router = useRouter();
  const href = useQueryHref();
  const [open, setOpen] = useState(defaultOpen);
  const [state, action, pending] = useActionState(createPacketAction, INITIAL);
  const formId = useId();
  useEffect(() => {
    if (state.ok && state.id) router.push(href({ create: null, peek: state.id, full: "1" }));
  }, [state, router, href]);
  return (
    <Dialog
      title={t("title")}
      description={t("description")}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next && defaultOpen) router.replace(href({ create: null }));
      }}
      trigger={
        <Button variant="primary" icon="Plus">
          {t("open")}
        </Button>
      }
      actions={
        <>
          <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
            {common("cancel")}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={pending}>
            {t("submit")}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submitWith(action)} className="flex flex-col gap-12" noValidate>
        <input type="hidden" name="org" value={org} />
        <TzOffset />
        <ErrorNotice state={state} />
        <Select
          id={`${formId}-project`}
          name="projectId"
          label={t("project")}
          value={defaultProjectId ?? ""}
          placeholder={t("projectHint")}
          options={[...projects]}
          error={state.fieldErrors?.["projectId"] ? t("projectError") : ""}
        />
        <Input
          id={`${formId}-title`}
          name="title"
          required
          maxLength={200}
          width="100%"
          label={t("name")}
          help={t("nameHelp")}
          error={state.fieldErrors?.["title"] ? t("nameError") : ""}
        />
        <Input
          id={`${formId}-due`}
          name="dueAt"
          type="datetime-local"
          width="100%"
          label={t("due")}
          help={t("dueHelp")}
          error={state.fieldErrors?.["dueAt"] ? t("dueError") : ""}
        />
      </form>
    </Dialog>
  );
}

export function PacketDetailsForm({
  org,
  packetId,
  title,
  dueAt,
  disabled,
}: {
  org: string;
  packetId: string;
  title: string;
  dueAt: string | null;
  disabled: boolean;
}) {
  const t = useCopy("advancing.packets.details");
  const common = useCopy("advancing.common");
  const [state, action, pending] = useActionState(updatePacketAction, INITIAL);
  const id = useId();
  return (
    <form onSubmit={submitWith(action)} className="flex flex-col gap-12" noValidate>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="packetId" value={packetId} />
      <TzOffset />
      <ErrorNotice state={state} />
      <Input
        id={`${id}-title`}
        name="title"
        required
        maxLength={200}
        width="100%"
        label={t("name")}
        defaultValue={title}
        disabled={disabled}
        error={state.fieldErrors?.["title"] ? t("nameError") : ""}
      />
      <Input
        id={`${id}-due`}
        name="dueAt"
        type="datetime-local"
        width="100%"
        label={t("due")}
        defaultValue={toLocalInput(dueAt)}
        disabled={disabled}
      />
      {disabled ? null : (
        <div className="flex items-center gap-12">
          <Button type="submit" variant="secondary" size="sm" loading={pending}>
            {common("save")}
          </Button>
          {state.ok ? (
            <p role="status" className="m-0 text-text-13 text-success-text">
              {common("saved")}
            </p>
          ) : null}
        </div>
      )}
    </form>
  );
}

export function SendPacketButton({
  org,
  packetId,
  title,
  recipients,
}: {
  org: string;
  packetId: string;
  title: string;
  recipients: number;
}) {
  const t = useCopy("advancing.packets.send");
  return (
    <ActButton
      action={sendPacketAction}
      fields={{ org, packetId }}
      label={t("action")}
      variant="primary"
      icon="Send"
      confirm={{
        title: t("confirmTitle", { title }),
        sentence: t("confirmSentence", { count: recipients }),
        actionLabel: t("action"),
      }}
    />
  );
}

export function ArchivePacketButton({
  org,
  packetId,
  title,
  backHref,
}: {
  org: string;
  packetId: string;
  title: string;
  backHref: string;
}) {
  const t = useCopy("advancing.packets.archive");
  const router = useRouter();
  const [state, action, pending] = useActionState(archivePacketAction, INITIAL);
  const [open, setOpen] = useState(false);
  const formId = useId();
  const common = useCopy("advancing.common");
  useEffect(() => {
    if (state.ok) router.push(backHref as Route);
  }, [state, router, backHref]);
  return (
    <form id={formId} onSubmit={submitWith(action)}>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="packetId" value={packetId} />
      <Dialog
        title={t("confirmTitle", { title })}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button variant="ghost" size="sm" icon="Archive" type="button">
            {t("action")}
          </Button>
        }
        actions={
          <>
            <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
              {common("cancel")}
            </Button>
            <Button variant="danger" type="submit" form={formId} loading={pending}>
              {t("action")}
            </Button>
          </>
        }
      >
        <p className="m-0">{t("confirmSentence")}</p>
      </Dialog>
      <ErrorNotice state={state} />
    </form>
  );
}

// Sections ------------------------------------------------------------------------------------------

export interface SectionItem {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly prompt: string | null;
}

function SectionEdit({
  org,
  section,
  onDone,
}: {
  org: string;
  section: SectionItem;
  onDone: () => void;
}) {
  const t = useCopy("advancing.sections");
  const common = useCopy("advancing.common");
  const [state, action, pending] = useActionState(async (prev: AdvancingState, form: FormData) => {
    const next = await updateSectionAction(prev, form);
    if (next.ok) onDone();
    return next;
  }, INITIAL);
  const id = useId();
  return (
    <form onSubmit={submitWith(action)} className="flex flex-col gap-8" noValidate>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="sectionId" value={section.id} />
      <ErrorNotice state={state} />
      <Input
        id={`${id}-title`}
        name="title"
        required
        maxLength={200}
        width="100%"
        label={t("name")}
        defaultValue={section.title}
        error={state.fieldErrors?.["title"] ? t("nameError") : ""}
      />
      <Textarea
        id={`${id}-prompt`}
        name="prompt"
        maxLength={2000}
        width="100%"
        label={t("prompt")}
        defaultValue={section.prompt ?? ""}
      />
      <div className="flex gap-8">
        <Button type="submit" size="sm" variant="primary" loading={pending}>
          {common("save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {common("cancel")}
        </Button>
      </div>
    </form>
  );
}

/**
 * The packet's sections in order. Before the packet is sent they can be added, reordered and
 * removed; after it is sent the list is fixed and only wording can be corrected (0430 guard).
 */
export function SectionList({
  org,
  packetId,
  sections,
  canEdit,
  sent,
}: {
  org: string;
  packetId: string;
  sections: readonly SectionItem[];
  canEdit: boolean;
  sent: boolean;
}) {
  const t = useCopy("advancing.sections");
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-12">
      {sections.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {canEdit ? t("emptyEditable") : t("empty")}
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
          {sections.map((s, i) => (
            <li key={s.id} className="flex flex-col gap-8 p-12">
              {editing === s.id ? (
                <SectionEdit org={org} section={s} onDone={() => setEditing(null)} />
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-8">
                  <div className="flex min-w-0 flex-col gap-2">
                    <span className="text-label-13 font-medium text-text-primary">
                      {t("numbered", { position: i + 1, title: s.title })}
                    </span>
                    {s.prompt ? (
                      <span className="text-text-13 text-text-secondary">{s.prompt}</span>
                    ) : null}
                  </div>
                  {canEdit ? (
                    <div className="flex items-center gap-2">
                      <IconButton
                        icon="Pencil"
                        label={t("edit", { title: s.title })}
                        onClick={() => setEditing(s.id)}
                      />
                      {sent ? null : (
                        <>
                          {i > 0 ? (
                            <ActButton
                              action={moveSectionAction}
                              fields={{ org, packetId, sectionId: s.id, direction: "up" }}
                              label={t("moveUp", { title: s.title })}
                              icon="ArrowUp"
                              iconOnly
                            />
                          ) : null}
                          {i < sections.length - 1 ? (
                            <ActButton
                              action={moveSectionAction}
                              fields={{ org, packetId, sectionId: s.id, direction: "down" }}
                              label={t("moveDown", { title: s.title })}
                              icon="ArrowDown"
                              iconOnly
                            />
                          ) : null}
                          <ActButton
                            action={removeSectionAction}
                            fields={{ org, sectionId: s.id }}
                            label={t("remove", { title: s.title })}
                            icon="Trash2"
                            iconOnly
                          />
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {canEdit && !sent ? <AddSectionForm org={org} packetId={packetId} /> : null}
      {canEdit && sent ? (
        <p className="m-0 text-text-12 text-text-tertiary">{t("fixedAfterSend")}</p>
      ) : null}
    </div>
  );
}

function AddSectionForm({ org, packetId }: { org: string; packetId: string }) {
  const t = useCopy("advancing.sections");
  const [state, action, pending, key] = useResettingAction(addSectionAction);
  const id = useId();
  return (
    <form key={key} onSubmit={submitWith(action)} className="flex flex-col gap-8" noValidate>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="packetId" value={packetId} />
      <ErrorNotice state={state} />
      <Input
        id={`${id}-title`}
        name="title"
        required
        maxLength={200}
        width="100%"
        label={t("newName")}
        help={t("newNameHelp")}
        error={state.fieldErrors?.["title"] ? t("nameError") : ""}
      />
      <Textarea
        id={`${id}-prompt`}
        name="prompt"
        maxLength={2000}
        width="100%"
        label={t("prompt")}
        help={t("promptHelp")}
      />
      <div>
        <Button type="submit" size="sm" icon="Plus" loading={pending}>
          {t("add")}
        </Button>
      </div>
    </form>
  );
}

// Recipients and links ------------------------------------------------------------------------------

export function AddRecipientForm({
  org,
  packetId,
  parties,
}: {
  org: string;
  packetId: string;
  parties: readonly Option[];
}) {
  const t = useCopy("advancing.recipients");
  const [state, action, pending] = useActionState(addRecipientAction, INITIAL);
  const id = useId();
  if (parties.length === 0) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("noParties")}</p>;
  }
  return (
    <form onSubmit={submitWith(action)} className="flex flex-wrap items-end gap-8" noValidate>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="packetId" value={packetId} />
      <Select
        id={`${id}-party`}
        name="party"
        label={t("party")}
        placeholder={t("partyHint")}
        options={[...parties]}
        error={state.fieldErrors?.["party"] ? t("partyError") : ""}
      />
      <Button type="submit" size="sm" icon="UserPlus" loading={pending}>
        {t("add")}
      </Button>
      <div className="basis-full">
        <ErrorNotice state={state} />
      </div>
    </form>
  );
}

export function RemoveRecipientButton({
  org,
  recipientId,
  name,
}: {
  org: string;
  recipientId: string;
  name: string;
}) {
  const t = useCopy("advancing.recipients");
  return (
    <ActButton
      action={removeRecipientAction}
      fields={{ org, recipientId }}
      label={t("remove", { name })}
      icon="UserMinus"
      iconOnly
    />
  );
}

/**
 * Issues a Gateway advance link for one recipient. The token and access code are shown once; the
 * coordinator shares them until A18 sends advance email.
 */
export function IssueLinkForm({
  org,
  recipientId,
  name,
}: {
  org: string;
  recipientId: string;
  name: string;
}) {
  const t = useCopy("advancing.links");
  const format = useFormatter();
  const [state, action, pending] = useActionState(issueLinkAction, INITIAL);
  const [copied, setCopied] = useState(false);
  const id = useId();
  const path = state.issued ? `/advance/${state.issued.token}` : null;
  return (
    <form onSubmit={submitWith(action)} className="flex flex-col gap-8" noValidate>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="recipientId" value={recipientId} />
      <ErrorNotice state={state} />
      <div className="flex flex-wrap items-end gap-8">
        <Input
          id={`${id}-email`}
          name="email"
          type="email"
          autoComplete="off"
          required
          label={t("email", { name })}
          error={state.fieldErrors?.["email"] ? t("emailError") : ""}
        />
        <Select
          id={`${id}-days`}
          name="validDays"
          label={t("validFor")}
          value="30"
          options={["7", "14", "30", "60", "90"].map((d) => ({
            value: d,
            label: t("days", { count: Number(d) }),
          }))}
        />
        <Button type="submit" size="sm" icon="Link" loading={pending}>
          {t("issue")}
        </Button>
      </div>
      {state.issued && path ? (
        <InlineAlert tone="success" title={t("issuedTitle")}>
          <span className="flex flex-col gap-4">
            <span>{t("issuedSentence")}</span>
            <code className="break-all font-mono text-text-12">{path}</code>
            <span>
              {t("accessCode")}{" "}
              <code className="font-mono text-text-13">{state.issued.accessCode}</code>
            </span>
            <span>
              {t("expires", {
                date: format.dateTime(new Date(state.issued.expiresAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </span>
            <span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                icon={copied ? "Check" : "Copy"}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(`${path}\n${t("accessCode")} ${state.issued?.accessCode ?? ""}`)
                    .then(() => setCopied(true));
                }}
              >
                {copied ? t("copied") : t("copy")}
              </Button>
            </span>
          </span>
        </InlineAlert>
      ) : null}
    </form>
  );
}

export function RevokeLinkButton({ org, linkId }: { org: string; linkId: string }) {
  const t = useCopy("advancing.links");
  return (
    <ActButton
      action={revokeLinkAction}
      fields={{ org, linkId }}
      label={t("revoke")}
      variant="ghost"
      confirm={{
        title: t("revokeTitle"),
        sentence: t("revokeSentence"),
        actionLabel: t("revoke"),
      }}
    />
  );
}

// Submissions ---------------------------------------------------------------------------------------

/** Accept or return an answer; returning needs a reason the recipient will read. */
export function ReviewForm({ org, submissionId }: { org: string; submissionId: string }) {
  const t = useCopy("advancing.review");
  const [state, action, pending] = useActionState(reviewSubmissionAction, INITIAL);
  const [returning, setReturning] = useState(false);
  const id = useId();
  return (
    <form onSubmit={submitWith(action)} className="flex flex-col gap-8" noValidate>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="submissionId" value={submissionId} />
      <ErrorNotice state={state} />
      {returning ? (
        <>
          <input type="hidden" name="outcome" value="Returned" />
          <Textarea
            id={`${id}-reason`}
            name="returnReason"
            required
            maxLength={1000}
            width="100%"
            label={t("reason")}
            help={t("reasonHelp")}
            error={state.fieldErrors?.["returnReason"] ? t("reasonError") : ""}
          />
          <div className="flex gap-8">
            <Button type="submit" size="sm" variant="danger" loading={pending}>
              {t("return")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setReturning(false)}>
              {t("back")}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex gap-8">
          <Button
            type="submit"
            name="outcome"
            value="Accepted"
            size="sm"
            variant="primary"
            icon="Check"
            loading={pending}
          >
            {t("accept")}
          </Button>
          <Button type="button" size="sm" icon="Undo2" onClick={() => setReturning(true)}>
            {t("returnStart")}
          </Button>
        </div>
      )}
    </form>
  );
}

/** Records an answer a recipient gave by phone or email, for a sent packet. */
export function RecordAnswerForm({
  org,
  sections,
  recipients,
}: {
  org: string;
  sections: readonly Option[];
  recipients: readonly Option[];
}) {
  const t = useCopy("advancing.record");
  const [state, action, pending, key] = useResettingAction(recordSubmissionAction);
  const id = useId();
  return (
    <form key={key} onSubmit={submitWith(action)} className="flex flex-col gap-8" noValidate>
      <input type="hidden" name="org" value={org} />
      <ErrorNotice state={state} />
      <div className="flex flex-wrap gap-8">
        <Select
          id={`${id}-section`}
          name="sectionId"
          label={t("section")}
          placeholder={t("sectionHint")}
          options={[...sections]}
          error={state.fieldErrors?.["sectionId"] ? t("sectionError") : ""}
        />
        <Select
          id={`${id}-recipient`}
          name="recipientId"
          label={t("recipient")}
          placeholder={t("recipientHint")}
          options={[...recipients]}
          error={state.fieldErrors?.["recipientId"] ? t("recipientError") : ""}
        />
      </div>
      <Textarea
        id={`${id}-body`}
        name="body"
        required
        maxLength={20000}
        rows={4}
        width="100%"
        label={t("body")}
        help={t("bodyHelp")}
        error={state.fieldErrors?.["body"] ? t("bodyError") : ""}
      />
      <div>
        <Button type="submit" size="sm" loading={pending}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

// Riders --------------------------------------------------------------------------------------------

export function CreateRiderDialog({
  org,
  projects,
  parties,
  defaultProjectId,
  defaultOpen,
}: {
  org: string;
  projects: readonly Option[];
  parties: readonly Option[];
  defaultProjectId: string | null;
  defaultOpen: boolean;
}) {
  const t = useCopy("advancing.riders.create");
  const common = useCopy("advancing.common");
  const router = useRouter();
  const href = useQueryHref();
  const [open, setOpen] = useState(defaultOpen);
  const [state, action, pending] = useActionState(createRiderAction, INITIAL);
  const formId = useId();
  useEffect(() => {
    if (state.ok && state.id) router.push(href({ create: null, peek: state.id, full: "1" }));
  }, [state, router, href]);
  return (
    <Dialog
      title={t("title")}
      description={t("description")}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next && defaultOpen) router.replace(href({ create: null }));
      }}
      trigger={
        <Button variant="primary" icon="Plus">
          {t("open")}
        </Button>
      }
      actions={
        <>
          <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
            {common("cancel")}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={pending}>
            {t("submit")}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submitWith(action)} className="flex flex-col gap-12" noValidate>
        <input type="hidden" name="org" value={org} />
        <ErrorNotice state={state} />
        <Select
          id={`${formId}-project`}
          name="projectId"
          label={t("project")}
          value={defaultProjectId ?? ""}
          placeholder={t("projectHint")}
          options={[...projects]}
          error={state.fieldErrors?.["projectId"] ? t("projectError") : ""}
        />
        <Input
          id={`${formId}-title`}
          name="title"
          required
          maxLength={200}
          width="100%"
          label={t("name")}
          help={t("nameHelp")}
          error={state.fieldErrors?.["title"] ? t("nameError") : ""}
        />
        <Select
          id={`${formId}-party`}
          name="counterpartyId"
          label={t("party")}
          value=""
          options={[{ value: "", label: t("noParty") }, ...parties]}
        />
      </form>
    </Dialog>
  );
}

export function RiderDetailsForm({
  org,
  riderId,
  title,
  counterpartyId,
  parties,
  disabled,
}: {
  org: string;
  riderId: string;
  title: string;
  counterpartyId: string | null;
  parties: readonly Option[];
  disabled: boolean;
}) {
  const t = useCopy("advancing.riders.details");
  const common = useCopy("advancing.common");
  const [state, action, pending] = useActionState(updateRiderAction, INITIAL);
  const id = useId();
  return (
    <form onSubmit={submitWith(action)} className="flex flex-col gap-12" noValidate>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="riderId" value={riderId} />
      <ErrorNotice state={state} />
      <Input
        id={`${id}-title`}
        name="title"
        required
        maxLength={200}
        width="100%"
        label={t("name")}
        defaultValue={title}
        disabled={disabled}
        error={state.fieldErrors?.["title"] ? t("nameError") : ""}
      />
      <Select
        id={`${id}-party`}
        name="counterpartyId"
        label={t("party")}
        value={counterpartyId ?? ""}
        disabled={disabled}
        options={[{ value: "", label: t("noParty") }, ...parties]}
      />
      {disabled ? null : (
        <div className="flex items-center gap-12">
          <Button type="submit" variant="secondary" size="sm" loading={pending}>
            {common("save")}
          </Button>
          {state.ok ? (
            <p role="status" className="m-0 text-text-13 text-success-text">
              {common("saved")}
            </p>
          ) : null}
        </div>
      )}
    </form>
  );
}

export function ArchiveRiderButton({
  org,
  riderId,
  title,
  backHref,
}: {
  org: string;
  riderId: string;
  title: string;
  backHref: string;
}) {
  const t = useCopy("advancing.riders.archive");
  const common = useCopy("advancing.common");
  const router = useRouter();
  const [state, action, pending] = useActionState(archiveRiderAction, INITIAL);
  const [open, setOpen] = useState(false);
  const formId = useId();
  useEffect(() => {
    if (state.ok) router.push(backHref as Route);
  }, [state, router, backHref]);
  return (
    <form id={formId} onSubmit={submitWith(action)}>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="riderId" value={riderId} />
      <Dialog
        title={t("confirmTitle", { title })}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button variant="ghost" size="sm" icon="Archive" type="button">
            {t("action")}
          </Button>
        }
        actions={
          <>
            <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
              {common("cancel")}
            </Button>
            <Button variant="danger" type="submit" form={formId} loading={pending}>
              {t("action")}
            </Button>
          </>
        }
      >
        <p className="m-0">{t("confirmSentence")}</p>
      </Dialog>
      <ErrorNotice state={state} />
    </form>
  );
}

export interface RiderLineItem {
  readonly id: string;
  readonly description: string;
  readonly elementId: string | null;
  readonly quantity: number | null;
  readonly fulfilledAt: string | null;
}

function LineFields({
  id,
  state,
  line,
}: {
  id: string;
  state: AdvancingState;
  line?: RiderLineItem;
}) {
  const t = useCopy("advancing.lines");
  return (
    <div className="flex flex-wrap items-end gap-8">
      <Input
        id={`${id}-description`}
        name="description"
        required
        maxLength={500}
        label={t("description")}
        defaultValue={line?.description ?? ""}
        error={state.fieldErrors?.["description"] ? t("descriptionError") : ""}
      />
      <Input
        id={`${id}-quantity`}
        name="quantity"
        inputMode="decimal"
        width={120}
        label={t("quantity")}
        help={t("quantityHelp")}
        defaultValue={line?.quantity === null || line === undefined ? "" : String(line.quantity)}
        error={state.fieldErrors?.["quantity"] ? t("quantityError") : ""}
      />
      <Input
        id={`${id}-element`}
        name="elementId"
        width={160}
        label={t("element")}
        help={t("elementHelp")}
        defaultValue={line?.elementId ?? ""}
      />
    </div>
  );
}

export function AddRiderLineForm({ org, riderId }: { org: string; riderId: string }) {
  const t = useCopy("advancing.lines");
  const [state, action, pending, key] = useResettingAction(addRiderLineAction);
  const id = useId();
  return (
    <form key={key} onSubmit={submitWith(action)} className="flex flex-col gap-8" noValidate>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="riderId" value={riderId} />
      <ErrorNotice state={state} />
      <LineFields id={id} state={state} />
      <div>
        <Button type="submit" size="sm" icon="Plus" loading={pending}>
          {t("add")}
        </Button>
      </div>
    </form>
  );
}

export function RiderLineRow({
  org,
  line,
  canEdit,
  fulfilledLabel,
}: {
  org: string;
  line: RiderLineItem;
  canEdit: boolean;
  fulfilledLabel: string | null;
}) {
  const t = useCopy("advancing.lines");
  const common = useCopy("advancing.common");
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState(async (prev: AdvancingState, form: FormData) => {
    const next = await updateRiderLineAction(prev, form);
    if (next.ok) setEditing(false);
    return next;
  }, INITIAL);
  const id = useId();
  if (editing) {
    return (
      <form onSubmit={submitWith(action)} className="flex flex-col gap-8" noValidate>
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="lineId" value={line.id} />
        <ErrorNotice state={state} />
        <LineFields id={id} state={state} line={line} />
        <div className="flex gap-8">
          <Button type="submit" size="sm" variant="primary" loading={pending}>
            {common("save")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {common("cancel")}
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-8">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-label-13 font-medium text-text-primary">{line.description}</span>
        <span className="text-text-12 text-text-secondary">
          {line.quantity === null ? t("noQuantity") : t("quantityValue", { count: line.quantity })}
          {line.elementId ? ` · ${line.elementId}` : ""}
          {fulfilledLabel ? ` · ${fulfilledLabel}` : ""}
        </span>
      </div>
      {canEdit ? (
        <div className="flex items-center gap-2">
          <ActButton
            action={toggleRiderLineAction}
            fields={{ org, lineId: line.id, fulfilled: line.fulfilledAt ? "false" : "true" }}
            label={line.fulfilledAt ? t("reopen") : t("fulfill")}
            icon={line.fulfilledAt ? "RotateCcw" : "Check"}
            variant={line.fulfilledAt ? "ghost" : "secondary"}
          />
          <IconButton
            icon="Pencil"
            label={t("edit", { description: line.description })}
            onClick={() => setEditing(true)}
          />
          <ActButton
            action={removeRiderLineAction}
            fields={{ org, lineId: line.id }}
            label={t("remove", { description: line.description })}
            icon="Trash2"
            iconOnly
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The rider extraction hook (A25): an assistant panel that read a rider document renders this
 * component with its proposals. Nothing is stored until the person picks the lines and confirms;
 * `onConfirm` receives only the chosen proposals and is A25's server action, which stores them
 * with confirmRiderLineProposals.
 */
export function RiderProposalReview({
  proposals,
  onConfirm,
}: {
  proposals: readonly RiderLineProposal[];
  onConfirm: (chosen: readonly RiderLineProposal[]) => Promise<void>;
}) {
  const t = useCopy("advancing.extraction");
  const format = useFormatter();
  const [chosen, setChosen] = useState<ReadonlySet<number>>(() => new Set(proposals.keys()));
  const [pending, setPending] = useState(false);
  return (
    <section aria-label={t("title")} className="flex flex-col gap-8">
      <p className="m-0 text-text-13 text-text-secondary">{t("sentence")}</p>
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {proposals.map((p, i) => (
          <li key={`${i}-${p.description}`}>
            <label className="flex items-start gap-8 text-text-13">
              <input
                type="checkbox"
                checked={chosen.has(i)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(i);
                  else next.delete(i);
                  setChosen(next);
                }}
              />
              <span className="flex flex-col">
                <span>{p.description}</span>
                <span className="text-text-12 text-text-secondary">
                  {t("confidence", {
                    value: format.number(p.confidence, { style: "percent" }),
                  })}
                  {p.source ? ` · ${p.source}` : ""}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div>
        <Button
          variant="primary"
          size="sm"
          loading={pending}
          disabled={chosen.size === 0}
          onClick={() => {
            setPending(true);
            void onConfirm(proposals.filter((_, i) => chosen.has(i))).finally(() =>
              setPending(false),
            );
          }}
        >
          {t("confirm", { count: chosen.size })}
        </Button>
      </div>
    </section>
  );
}

// Reconciliation ------------------------------------------------------------------------------------

export function RunReconciliationForm({
  org,
  projects,
  defaultProjectId,
}: {
  org: string;
  projects: readonly Option[];
  defaultProjectId: string | null;
}) {
  const t = useCopy("advancing.reconciliation.run");
  const router = useRouter();
  const href = useQueryHref();
  const [state, action, pending] = useActionState(runReconciliationAction, INITIAL);
  const id = useId();
  useEffect(() => {
    if (state.ok && state.id) router.push(href({ peek: state.id, full: "1" }));
  }, [state, router, href]);
  return (
    <form onSubmit={submitWith(action)} className="flex flex-wrap items-end gap-8" noValidate>
      <input type="hidden" name="org" value={org} />
      {defaultProjectId ? (
        <input type="hidden" name="projectId" value={defaultProjectId} />
      ) : (
        <Select
          id={`${id}-project`}
          name="projectId"
          label={t("project")}
          placeholder={t("projectHint")}
          options={[...projects]}
          error={state.fieldErrors?.["projectId"] ? t("projectError") : ""}
        />
      )}
      <Input id={`${id}-note`} name="note" maxLength={1000} label={t("note")} />
      <Button type="submit" variant="primary" icon="Scale" loading={pending}>
        {t("action")}
      </Button>
      <div className="basis-full">
        <ErrorNotice state={state} />
      </div>
    </form>
  );
}

/** A section of a record page: heading and body. */
export function Panel({
  id,
  title,
  children,
  actions,
}: {
  id: string;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-12">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <h2 id={id} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
