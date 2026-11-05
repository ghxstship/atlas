"use client";

import { Button, Checkbox, Dialog, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import { startTransition, useActionState, useId, useState, type FormEvent } from "react";
import type { AdvancingState } from "./actions";
import {
  addGuestAction,
  moveGuestAction,
  removeGuestAction,
  updateGuestAction,
} from "./guest-actions";
import { useCopy } from "./use-copy";
import type { Database } from "@xos/data/database.types";

type Action = (state: AdvancingState, form: FormData) => Promise<AdvancingState>;

export interface ScopeChoice {
  readonly value: string;
  readonly label: string;
}

export interface GuestItem {
  readonly id: string;
  readonly guestName: string;
  readonly plusOnes: number;
  readonly note: string | null;
  readonly scopeNodeId: string | null;
}

/** Posts in a transition so a refused submit keeps its input; `onDone` runs after a success. */
function useSubmit(action: Action, onDone?: () => void) {
  const [state, run, pending] = useActionState<AdvancingState, FormData>(async (prev, form) => {
    const next = await action(prev, form);
    if (next.ok) onDone?.();
    return next;
  }, {});
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const data = new FormData(event.currentTarget, submitter);
    startTransition(() => run(data));
  };
  return { state, pending, onSubmit };
}

function ErrorLine({ state }: { state: AdvancingState }) {
  const t = useCopy("advancing.errors");
  return state.error ? (
    <InlineAlert tone="danger" title={t("title")}>
      {t(state.error)}
    </InlineAlert>
  ) : null;
}

function GuestFields({
  id,
  state,
  scopes,
  guest,
}: {
  id: string;
  state: AdvancingState;
  scopes: readonly ScopeChoice[];
  guest?: GuestItem;
}) {
  const t = useCopy("advancing.guests.form");
  return (
    <>
      <Input
        id={`${id}-name`}
        name="guestName"
        required
        maxLength={200}
        width="100%"
        label={t("name")}
        help={t("nameHelp")}
        defaultValue={guest?.guestName ?? ""}
        error={state.fieldErrors?.["guestName"] ? t("nameError") : ""}
      />
      <Input
        id={`${id}-plus`}
        name="plusOnes"
        type="number"
        min={0}
        max={20}
        width={120}
        label={t("plusOnes")}
        defaultValue={String(guest?.plusOnes ?? 0)}
        error={state.fieldErrors?.["plusOnes"] ? t("plusOnesError") : ""}
      />
      <Select
        id={`${id}-scope`}
        name="scopeNodeId"
        label={t("show")}
        value={guest?.scopeNodeId ?? ""}
        options={[{ value: "", label: t("wholeProject") }, ...scopes]}
      />
      <Textarea
        id={`${id}-note`}
        name="note"
        maxLength={500}
        width="100%"
        label={t("note")}
        help={t("noteHelp")}
        defaultValue={guest?.note ?? ""}
      />
    </>
  );
}

/** Adds a guest as Requested; a reviewer may add an approved comp instead. */
export function AddGuestDialog({
  org,
  projectId,
  scopes,
  canApprove,
}: {
  org: string;
  projectId: string;
  scopes: readonly ScopeChoice[];
  canApprove: boolean;
}) {
  const t = useCopy("advancing.guests.form");
  const common = useCopy("advancing.common");
  const [open, setOpen] = useState(false);
  const formId = useId();
  const { state, pending, onSubmit } = useSubmit(addGuestAction, () => setOpen(false));
  return (
    <Dialog
      title={t("addTitle")}
      description={t("addDescription")}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="primary" icon="UserPlus">
          {t("add")}
        </Button>
      }
      actions={
        <>
          <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
            {common("cancel")}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={pending}>
            {t("addSubmit")}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-12" noValidate>
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="projectId" value={projectId} />
        <ErrorLine state={state} />
        <GuestFields id={formId} state={state} scopes={scopes} />
        {canApprove ? (
          <Checkbox id={`${formId}-approve`} name="approve" value="true" label={t("approveNow")} />
        ) : null}
      </form>
    </Dialog>
  );
}

function MoveButton({
  org,
  guestId,
  to,
  label,
  variant,
}: {
  org: string;
  guestId: string;
  to: "Approved" | "Declined" | "Checked In";
  label: string;
  variant: "primary" | "secondary" | "ghost";
}) {
  const { state, pending, onSubmit } = useSubmit(moveGuestAction);
  return (
    <form onSubmit={onSubmit} className="inline-flex flex-col gap-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="guestId" value={guestId} />
      <input type="hidden" name="to" value={to} />
      <Button type="submit" size="sm" variant={variant} loading={pending}>
        {label}
      </Button>
      <ErrorLine state={state} />
    </form>
  );
}

/** The actions a viewer may take on one guest, by state and authority. */
export function GuestActions({
  org,
  guest,
  state,
  scopes,
  canEdit,
  canReview,
}: {
  org: string;
  guest: GuestItem;
  state: Database["app"]["Enums"]["guest_entry_state"];
  scopes: readonly ScopeChoice[];
  canEdit: boolean;
  canReview: boolean;
}) {
  const t = useCopy("advancing.guests.actions");
  const common = useCopy("advancing.common");
  const [editing, setEditing] = useState(false);
  const id = useId();
  const update = useSubmit(updateGuestAction, () => setEditing(false));
  const remove = useSubmit(removeGuestAction);
  if (editing) {
    return (
      <form onSubmit={update.onSubmit} className="flex basis-full flex-col gap-8" noValidate>
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="guestId" value={guest.id} />
        <ErrorLine state={update.state} />
        <GuestFields id={id} state={update.state} scopes={scopes} guest={guest} />
        <div className="flex gap-8">
          <Button type="submit" size="sm" variant="primary" loading={update.pending}>
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
    <div className="flex flex-wrap items-start gap-8">
      {canReview && state === "Requested" ? (
        <>
          <MoveButton
            org={org}
            guestId={guest.id}
            to="Approved"
            label={t("approve", { name: guest.guestName })}
            variant="primary"
          />
          <MoveButton
            org={org}
            guestId={guest.id}
            to="Declined"
            label={t("decline", { name: guest.guestName })}
            variant="secondary"
          />
        </>
      ) : null}
      {canEdit && state === "Approved" ? (
        <MoveButton
          org={org}
          guestId={guest.id}
          to="Checked In"
          label={t("checkIn", { name: guest.guestName })}
          variant="primary"
        />
      ) : null}
      {canEdit && state === "Requested" ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
          {t("edit", { name: guest.guestName })}
        </Button>
      ) : null}
      {canEdit && state !== "Checked In" ? (
        <form onSubmit={remove.onSubmit} className="inline-flex flex-col gap-4">
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="guestId" value={guest.id} />
          <Button type="submit" size="sm" variant="ghost" loading={remove.pending}>
            {t("remove", { name: guest.guestName })}
          </Button>
          <ErrorLine state={remove.state} />
        </form>
      ) : null}
    </div>
  );
}
