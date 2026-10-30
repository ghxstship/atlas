"use client";

import { Button, Checkbox, Dialog, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import type { AllocationAllowance, AssetClassAvailability } from "@xos/data/allocations";
import {
  startTransition,
  useActionState,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AdvancingState } from "./actions";
import {
  assignAllocationAction,
  decideAllocationAction,
  issueAllocationAction,
  loadAllowances,
  loadAssignOptions,
  loadAvailability,
  loadIssueVehicle,
  splitAllocationAction,
  unsplitAllocationAction,
  withdrawAllocationAction,
  type AssignOptions,
  type IssueVehicle,
} from "./allocation-actions";
import { useCopy, type Translate } from "./use-copy";

/**
 * The allocation dialogs of Atlas (R7), loaded on demand with next/dynamic so the page carries none of their code:
 * Assign (or Request), Review (Approve with the hold sources, the allowance and, for radios, the channels; Decline
 * with a reason), Split, Issue (per kind; tags by scan or typing; a parking pass names the person's vehicle through
 * R5's logged read), Withdraw and Return to pool. Each submits a server action; refusals show their catalog copy.
 */

type Action = (prev: AdvancingState, form: FormData) => Promise<AdvancingState>;

function useDialogAction(action: Action, onDone: () => void) {
  const [state, run, pending] = useActionState<AdvancingState, FormData>(async (prev, form) => {
    const next = await action(prev, form);
    if (next.ok) onDone();
    return next;
  }, {});
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    startTransition(() => run(new FormData(event.currentTarget, submitter)));
  };
  return { state, pending, submit };
}

function Refusal({ state }: { state: AdvancingState }) {
  const errors = useCopy("advancing.errors");
  return state.error ? (
    <InlineAlert tone="danger" title={errors("title")}>
      {errors(state.error)}
    </InlineAlert>
  ) : null;
}

/** "Available 4 of 6 each for these dates", refreshed as the class or the dates change. */
function AvailabilityLine({
  org,
  assetClassId,
  from,
  to,
  timeZone,
}: {
  org: string;
  assetClassId: string | null;
  from: string;
  to: string;
  timeZone: string;
}) {
  const t = useCopy("assets.availability");
  const key = assetClassId && from && to ? `${assetClassId}|${from}|${to}|${timeZone}` : null;
  const [read, setRead] = useState<{ key: string; value: AssetClassAvailability | null } | null>(
    null,
  );
  useEffect(() => {
    if (!key || !assetClassId) return;
    let live = true;
    void loadAvailability(org, assetClassId, from, to, timeZone).then((value) => {
      if (live) setRead({ key, value });
    });
    return () => {
      live = false;
    };
  }, [org, key, assetClassId, from, to, timeZone]);
  if (!key) return null;
  const value = read?.key === key ? read.value : "loading";
  if (value === null) return null;
  return (
    <p className="m-0 text-text-13 text-text-secondary" aria-live="polite">
      {value === "loading"
        ? t("loading")
        : t("line", { available: value.available, total: value.total, unit: value.unitBasis })}
    </p>
  );
}

/** Remaining allowance, and the reason field when the quantity goes beyond it. */
function AllowanceBlock({
  t,
  allowance,
  adding,
  name,
  required,
}: {
  t: Translate;
  allowance: AllocationAllowance | null;
  adding: number;
  name: string;
  required: boolean;
}) {
  if (!allowance || allowance.cap === null || allowance.remaining === null) return null;
  const beyond = Math.max(adding - allowance.remaining, 0);
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-text-13 text-text-secondary">
        {t("allowance.remaining", { remaining: allowance.remaining, cap: allowance.cap })}
      </p>
      {beyond > 0 ? (
        <>
          <p className="m-0 text-text-13 text-text-primary">
            {t("allowance.beyond", { n: beyond })}
          </p>
          {required ? (
            <Textarea
              name={name}
              required
              maxLength={1000}
              width="100%"
              label={t("allowance.reason")}
              help={t("allowance.reasonHelp")}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The allowance row for a holder and offering: the person's own row with a cap, else the pool's. */
function pickAllowance(
  rows: readonly AllocationAllowance[],
  offering: string | null,
  rosterEntryId: string | null,
): AllocationAllowance | null {
  if (!offering) return null;
  const mine = rosterEntryId
    ? rows.find(
        (r) => r.offering === offering && r.rosterEntryId === rosterEntryId && r.cap !== null,
      )
    : undefined;
  return mine ?? rows.find((r) => r.offering === offering && r.rosterEntryId === null) ?? null;
}

function ChannelPicker({
  t,
  channels,
  hint,
}: {
  t: Translate;
  channels: AssignOptions["channels"];
  hint: string | null;
}) {
  if (channels.length === 0) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("channels.noChannels")}</p>;
  }
  return (
    <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
      <legend className="text-label-13 font-medium">{t("channels.label")}</legend>
      <p className="m-0 text-text-12 text-text-secondary">{t("channels.help")}</p>
      {hint ? (
        <p className="m-0 text-text-12 text-text-secondary">
          {t("channels.hint", { channel: hint })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-8">
        {channels.map((c) => (
          <Checkbox
            key={c.id}
            name="channel"
            value={c.id}
            label={`${c.channelNumber} · ${c.name}`}
          />
        ))}
      </div>
    </fieldset>
  );
}

/** The role's default channel matched to the project's channels by number or name: a hint, never saved. */
function channelHint(text: string | undefined, channels: AssignOptions["channels"]): string | null {
  const v = (text ?? "").trim().toLowerCase();
  if (!v) return null;
  const n = /\d+/.exec(v)?.[0];
  const c =
    channels.find((x) => n !== undefined && x.channelNumber === Number(n)) ??
    channels.find((x) => x.name.trim().toLowerCase() === v) ??
    channels.find((x) => v.includes(x.name.trim().toLowerCase()));
  return c ? `${c.channelNumber} · ${c.name}` : null;
}

/** Rows of hold sources, sent as JSON in one field. */
function SourcesEditor({ t, quantity }: { t: Translate; quantity: number }) {
  type Row = { source: string; id: string; quantity: number };
  const [rows, setRows] = useState<Row[]>([{ source: "Class Stock", id: "", quantity }]);
  const held = rows.reduce((n, r) => n + (Number.isFinite(r.quantity) ? r.quantity : 0), 0);
  const set = (i: number, patch: Partial<Row>) =>
    setRows(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  const options = [
    { value: "Class Stock", label: t("review.sourceStock") },
    { value: "Unit", label: t("review.sourceUnit") },
    { value: "Lot", label: t("review.sourceLot") },
    { value: "Order Line", label: t("review.sourceLine") },
  ];
  return (
    <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
      <legend className="text-label-13 font-medium">{t("review.sources")}</legend>
      <p className="m-0 text-text-12 text-text-secondary">{t("review.sourcesHelp")}</p>
      <input type="hidden" name="sources" value={JSON.stringify(rows)} />
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-end gap-8">
          <Select
            label={t("review.source")}
            value={r.source}
            options={options}
            onChange={(e) => set(i, { source: e.target.value })}
          />
          {r.source !== "Class Stock" ? (
            <Input
              label={t("review.sourceId")}
              value={r.id}
              onChange={(e) => set(i, { id: e.target.value })}
            />
          ) : null}
          <Input
            label={t("review.sourceQuantity")}
            type="number"
            min={0}
            step="any"
            width={120}
            value={String(r.quantity)}
            onChange={(e) => set(i, { quantity: Number(e.target.value) })}
          />
          {rows.length > 1 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              {t("review.removeSource")}
            </Button>
          ) : null}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-8">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setRows([...rows, { source: "Lot", id: "", quantity: 0 }])}
        >
          {t("review.addSource")}
        </Button>
        <span className="text-text-12 text-text-secondary">
          {t("review.sourceSum", { held, quantity })}
        </span>
      </div>
    </fieldset>
  );
}

function DialogShell({
  title,
  description,
  open,
  setOpen,
  trigger,
  formId,
  pending,
  submitLabel,
  submitName,
  submitValue,
  extraActions,
  children,
}: {
  title: string;
  description?: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  trigger: ReactElement;
  formId: string;
  pending: boolean;
  submitLabel: string;
  /** The primary button's own name and value, when the form's other button sends another value. */
  submitName?: string;
  submitValue?: string;
  extraActions?: ReactNode;
  children: ReactNode;
}) {
  const t = useCopy("advancing.allocations");
  return (
    <Dialog
      title={title}
      {...(description ? { description } : {})}
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
            {t("actions.cancel")}
          </Button>
          {extraActions}
          <Button
            variant="primary"
            type="submit"
            form={formId}
            disabled={pending}
            aria-busy={pending}
            {...(submitName ? { name: submitName, value: submitValue ?? "" } : {})}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

// Assign -------------------------------------------------------------------------------------------------------------

export function AllocationAssignDialog({
  org,
  projectId,
  timeZone,
  canAssign,
  canRequest,
}: {
  org: string;
  projectId: string;
  timeZone: string;
  canAssign: boolean;
  canRequest: boolean;
}) {
  const t = useCopy("advancing.allocations");
  const [open, setOpen] = useState(false);
  const formId = useId();
  const { state, pending, submit } = useDialogAction(assignAllocationAction, () => setOpen(false));
  const [options, setOptions] = useState<AssignOptions | null>(null);
  const [holder, setHolder] = useState("");
  const [kind, setKind] = useState("credential");
  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [allowances, setAllowances] = useState<readonly AllocationAllowance[]>([]);

  useEffect(() => {
    if (!open || options) return;
    void loadAssignOptions(org, projectId).then(setOptions);
  }, [open, options, org, projectId]);

  const holderRow = options?.holders.find(
    (h) =>
      (h.kind === "Pool" ? `pool:${h.engagementId}` : `entry:${h.rosterEntryId ?? ""}`) === holder,
  );
  useEffect(() => {
    if (!holderRow) return;
    void loadAllowances(org, holderRow.engagementId).then(setAllowances);
  }, [org, holderRow]);

  const items = useMemo(
    () => (options?.items ?? []).filter((i) => i.kind === kind),
    [options, kind],
  );
  const chosen = items.find((i) => i.value === item) ?? items[0];
  const allowance = pickAllowance(
    allowances,
    chosen?.offering ?? null,
    holderRow?.rosterEntryId ?? null,
  );
  const kinds = [
    "credential",
    "parking_pass",
    "asset",
    "catering",
    "lodging",
    "travel",
    "per_diem",
  ];

  return (
    <DialogShell
      title={t("assign.title")}
      open={open}
      setOpen={setOpen}
      trigger={
        <Button type="button" size="sm" variant="primary">
          {t("actions.assign")}
        </Button>
      }
      formId={formId}
      pending={pending}
      submitLabel={canAssign ? t("assign.submit") : t("assign.request")}
      submitName="intent"
      submitValue={canAssign ? "assign" : "request"}
      extraActions={
        canAssign && canRequest ? (
          <Button
            variant="ghost"
            type="submit"
            form={formId}
            name="intent"
            value="request"
            disabled={pending}
          >
            {t("assign.request")}
          </Button>
        ) : null
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-8">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="timeZone" value={timeZone} />
        <Select
          name="holder"
          label={t("assign.holder")}
          placeholder={t("assign.holder")}
          options={(options?.holders ?? []).map((h) => ({
            value: h.kind === "Pool" ? `pool:${h.engagementId}` : `entry:${h.rosterEntryId ?? ""}`,
            label:
              h.kind === "Pool"
                ? t("assign.holderPool", { party: h.partyName ?? "" })
                : t("assign.holderPerson", { name: h.holderName ?? "", party: h.partyName ?? "" }),
          }))}
          onChange={(e) => setHolder(e.target.value)}
        />
        <Select
          label={t("assign.kind")}
          value={kind}
          options={kinds.map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
          onChange={(e) => {
            setKind(e.target.value);
            setItem("");
          }}
        />
        {items.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("assign.noItems")}</p>
        ) : (
          <Select
            key={kind}
            name="target"
            label={t("assign.item")}
            value={chosen?.value ?? ""}
            options={items.map((i) => ({ value: i.value, label: i.label || t(`kinds.${i.kind}`) }))}
            onChange={(e) => setItem(e.target.value)}
          />
        )}
        <Input
          name="quantity"
          type="number"
          min={0}
          step="any"
          label={t("assign.quantity")}
          value={String(quantity)}
          onChange={(e) => setQuantity(Number(e.target.value))}
          width={140}
        />
        <div className="flex flex-wrap gap-8">
          <Input
            name="from"
            type="datetime-local"
            required
            label={t("assign.from")}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <Input
            name="to"
            type="datetime-local"
            required
            label={t("assign.to")}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <p className="m-0 text-text-12 text-text-secondary">
          {t("assign.timeZone")}: {timeZone}
        </p>
        {chosen?.kind === "asset" ? (
          <AvailabilityLine
            org={org}
            assetClassId={chosen.value.slice("asset:".length)}
            from={from}
            to={to}
            timeZone={timeZone}
          />
        ) : null}
        <AllowanceBlock
          t={t}
          allowance={allowance}
          adding={quantity}
          name="note"
          required={false}
        />
        {chosen?.radios && options ? (
          <ChannelPicker
            t={t}
            channels={options.channels}
            hint={channelHint(
              holderRow?.roleCode ? options.roleChannels[holderRow.roleCode] : undefined,
              options.channels,
            )}
          />
        ) : null}
        <Textarea
          name="note"
          maxLength={1000}
          width="100%"
          label={t("assign.note")}
          help={t("assign.noteHelp")}
        />
        <Refusal state={state} />
      </form>
    </DialogShell>
  );
}

// Row actions ----------------------------------------------------------------------------------------------------------

/** What a row's dialogs need to know about its allocation. */
export interface AllocationRowProps {
  readonly id: string;
  readonly kind: string;
  readonly quantity: number;
  readonly issued: number;
  readonly item: string;
  readonly holder: string;
  readonly window: string;
  readonly offering: string | null;
  readonly rosterEntryId: string | null;
  /** The engagement the allocation is held under, for allowances and the split's people. */
  readonly engagementId: string | null;
  readonly projectId: string;
  readonly assetClassId: string | null;
  readonly fromLocal: string;
  readonly toLocal: string;
  readonly timeZone: string;
}

export function AllocationRowActions({
  org,
  row,
  actions,
}: {
  org: string;
  row: AllocationRowProps;
  actions: readonly ("review" | "split" | "unsplit" | "issue" | "withdraw")[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      {actions.includes("review") ? <ReviewDialog org={org} row={row} /> : null}
      {actions.includes("issue") ? <IssueDialog org={org} row={row} /> : null}
      {actions.includes("split") ? <SplitDialog org={org} row={row} /> : null}
      {actions.includes("unsplit") ? <UnsplitButton org={org} row={row} /> : null}
      {actions.includes("withdraw") ? <WithdrawDialog org={org} row={row} /> : null}
    </div>
  );
}

function ReviewDialog({ org, row }: { org: string; row: AllocationRowProps }) {
  const t = useCopy("advancing.allocations");
  const [open, setOpen] = useState(false);
  const formId = useId();
  const { state, pending, submit } = useDialogAction(decideAllocationAction, () => setOpen(false));
  const [allowances, setAllowances] = useState<readonly AllocationAllowance[]>([]);
  const [options, setOptions] = useState<AssignOptions | null>(null);
  const radios = row.offering === "Radios";
  useEffect(() => {
    if (!open) return;
    if (row.engagementId) void loadAllowances(org, row.engagementId).then(setAllowances);
    if (radios && !options) void loadAssignOptions(org, row.projectId).then(setOptions);
  }, [open, org, row.engagementId, row.projectId, radios, options]);
  // The quantity under review is already counted as Requested, so what remains is compared with 0 more.
  const allowance = pickAllowance(allowances, row.offering, row.rosterEntryId);
  const beyondNow =
    allowance && allowance.cap !== null
      ? Math.max(allowance.requested + allowance.approved - allowance.cap, 0)
      : 0;
  const holderRole =
    options?.holders.find((h) => h.rosterEntryId === row.rosterEntryId)?.roleCode ?? null;
  return (
    <DialogShell
      title={t("review.title", { item: row.item })}
      description={t("review.sentence", {
        quantity: row.quantity,
        holder: row.holder,
        window: row.window,
      })}
      open={open}
      setOpen={setOpen}
      trigger={
        <Button type="button" size="sm" variant="secondary">
          {t("actions.review")}
        </Button>
      }
      formId={formId}
      pending={pending}
      submitLabel={t("review.approveSubmit")}
      submitName="decision"
      submitValue="Approved"
      extraActions={
        <Button
          variant="ghost"
          type="submit"
          form={formId}
          name="decision"
          value="Rejected"
          disabled={pending}
        >
          {t("review.declineSubmit")}
        </Button>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-8">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="id" value={row.id} />
        {row.kind === "Asset" ? (
          <>
            <AvailabilityLine
              org={org}
              assetClassId={row.assetClassId}
              from={row.fromLocal}
              to={row.toLocal}
              timeZone={row.timeZone}
            />
            <SourcesEditor t={t} quantity={row.quantity} />
          </>
        ) : null}
        {allowance && allowance.cap !== null && allowance.remaining !== null ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("allowance.remaining", { remaining: allowance.remaining, cap: allowance.cap })}
          </p>
        ) : null}
        {beyondNow > 0 ? (
          <p className="m-0 text-text-13 text-text-primary">
            {t("allowance.beyond", { n: beyondNow })}
          </p>
        ) : null}
        <Textarea
          name="reason"
          maxLength={1000}
          width="100%"
          label={beyondNow > 0 ? t("allowance.reason") : t("review.declineReason")}
          help={beyondNow > 0 ? t("allowance.reasonHelp") : ""}
          required={beyondNow > 0}
        />
        {radios && options ? (
          <>
            <input type="hidden" name="channelsSent" value="1" />
            <ChannelPicker
              t={t}
              channels={options.channels}
              hint={channelHint(
                holderRole ? options.roleChannels[holderRole] : undefined,
                options.channels,
              )}
            />
          </>
        ) : null}
        <Refusal state={state} />
      </form>
    </DialogShell>
  );
}

function SplitDialog({ org, row }: { org: string; row: AllocationRowProps }) {
  const t = useCopy("advancing.allocations");
  const [open, setOpen] = useState(false);
  const formId = useId();
  const { state, pending, submit } = useDialogAction(splitAllocationAction, () => setOpen(false));
  const [options, setOptions] = useState<AssignOptions | null>(null);
  const [parts, setParts] = useState(1);
  useEffect(() => {
    if (open && !options) void loadAssignOptions(org, row.projectId).then(setOptions);
  }, [open, options, org, row.projectId]);
  const people = (options?.holders ?? []).filter(
    (h) =>
      h.kind === "Person" &&
      h.engagementId === row.engagementId &&
      h.entryState === "Accepted" &&
      h.personResponse === "Accepted",
  );
  return (
    <DialogShell
      title={t("splitDialog.title", { item: row.item })}
      description={t("splitDialog.sentence", { left: row.quantity - row.issued })}
      open={open}
      setOpen={setOpen}
      trigger={
        <Button type="button" size="sm" variant="ghost">
          {t("actions.split")}
        </Button>
      }
      formId={formId}
      pending={pending}
      submitLabel={t("splitDialog.submit")}
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-8">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="id" value={row.id} />
        {Array.from({ length: parts }, (_, i) => (
          <div key={i} className="flex flex-wrap items-end gap-8">
            <Select
              name="entry"
              label={t("splitDialog.person")}
              placeholder={t("splitDialog.person")}
              options={people.map((p) => ({
                value: p.rosterEntryId ?? "",
                label: p.holderName ?? "",
              }))}
            />
            <Input
              name="quantity"
              type="number"
              min={0}
              step="any"
              width={120}
              label={t("splitDialog.quantity")}
              defaultValue="1"
            />
            {row.kind === "Asset" ? (
              <Input
                name="units"
                label={t("splitDialog.units")}
                help={t("splitDialog.unitsHelp")}
              />
            ) : null}
          </div>
        ))}
        <div>
          <Button type="button" size="sm" variant="ghost" onClick={() => setParts(parts + 1)}>
            {t("splitDialog.addPerson")}
          </Button>
        </div>
        <Refusal state={state} />
      </form>
    </DialogShell>
  );
}

function IssueDialog({ org, row }: { org: string; row: AllocationRowProps }) {
  const t = useCopy("advancing.allocations");
  const [open, setOpen] = useState(false);
  const formId = useId();
  const [eventId, setEventId] = useState(() => crypto.randomUUID());
  const { state, pending, submit } = useDialogAction(issueAllocationAction, () => {
    setOpen(false);
    setEventId(crypto.randomUUID());
  });
  const [vehicle, setVehicle] = useState<IssueVehicle | null | "none">(null);
  useEffect(() => {
    if (open && row.kind === "Parking Pass" && row.rosterEntryId && vehicle === null) {
      void loadIssueVehicle(org, row.rosterEntryId).then((v) => setVehicle(v ?? "none"));
    }
  }, [open, org, row.kind, row.rosterEntryId, vehicle]);
  const field = (
    name: string,
    label: string,
    type = "text",
    extra: Record<string, unknown> = {},
  ) => <Input key={name} name={name} type={type} label={label} {...extra} />;
  return (
    <DialogShell
      title={t("issueDialog.title", { item: row.item })}
      description={t("issueDialog.sentence", {
        issued: row.issued,
        quantity: row.quantity,
        holder: row.holder,
      })}
      open={open}
      setOpen={setOpen}
      trigger={
        <Button type="button" size="sm" variant="secondary">
          {t("actions.issue")}
        </Button>
      }
      formId={formId}
      pending={pending}
      submitLabel={t("issueDialog.submit")}
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-8">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="id" value={row.id} />
        <input type="hidden" name="eventId" value={eventId} />
        <input type="hidden" name="kind" value={row.kind} />
        <input type="hidden" name="timeZone" value={row.timeZone} />
        {row.kind === "Credential" || row.kind === "Parking Pass" ? (
          <>
            {field("validFrom", t("issueDialog.validFrom"), "datetime-local", {
              defaultValue: row.fromLocal,
            })}
            {field("validTo", t("issueDialog.validTo"), "datetime-local", {
              defaultValue: row.toLocal,
            })}
            {row.kind === "Parking Pass" ? (
              <Select
                name="vehicle"
                label={t("issueDialog.vehicle")}
                options={[
                  { value: "", label: t("issueDialog.noVehicle") },
                  ...(vehicle && vehicle !== "none"
                    ? [{ value: vehicle.id, label: vehicle.label }]
                    : []),
                ]}
                value={vehicle && vehicle !== "none" ? vehicle.id : ""}
              />
            ) : null}
          </>
        ) : row.kind === "Asset" ? (
          <Textarea
            name="tags"
            width="100%"
            label={t("issueDialog.tags")}
            help={t("issueDialog.tagsHelp")}
            autoFocus
          />
        ) : row.kind === "Catering" ? (
          <>
            {field("description", t("issueDialog.description"))}
            {field("quantity", t("issueDialog.quantity"), "number", {
              defaultValue: "1",
              min: 0,
              step: "any",
            })}
          </>
        ) : row.kind === "Lodging" ? (
          <>
            {field("checkIn", t("issueDialog.checkIn"), "date")}
            {field("checkOut", t("issueDialog.checkOut"), "date")}
          </>
        ) : row.kind === "Travel" ? (
          <>
            <Select
              name="travelMode"
              label={t("issueDialog.travelMode")}
              options={[
                { value: "Flight", label: t("issueDialog.flight") },
                { value: "Ground", label: t("issueDialog.ground") },
              ]}
            />
            {field("departsFrom", t("issueDialog.departsFrom"), "text", { required: true })}
            {field("departsAt", t("issueDialog.departsAt"), "datetime-local", { required: true })}
            {field("arrivesAtPlace", t("issueDialog.arrivesAtPlace"), "text", { required: true })}
            {field("arrivesAt", t("issueDialog.arrivesAt"), "datetime-local")}
          </>
        ) : (
          <>
            {field("day", t("issueDialog.day"), "date", { required: true })}
            {field("amount", t("issueDialog.amount"), "number", {
              required: true,
              min: 0,
              step: "0.01",
            })}
            {field("currency", t("issueDialog.currency"), "text", {
              defaultValue: "USD",
              maxLength: 3,
            })}
          </>
        )}
        <Refusal state={state} />
      </form>
    </DialogShell>
  );
}

function WithdrawDialog({ org, row }: { org: string; row: AllocationRowProps }) {
  const t = useCopy("advancing.allocations");
  const [open, setOpen] = useState(false);
  const formId = useId();
  const { state, pending, submit } = useDialogAction(withdrawAllocationAction, () =>
    setOpen(false),
  );
  return (
    <DialogShell
      title={t("withdrawDialog.title", { item: row.item })}
      description={t("withdrawDialog.sentence")}
      open={open}
      setOpen={setOpen}
      trigger={
        <Button type="button" size="sm" variant="ghost">
          {t("actions.withdraw")}
        </Button>
      }
      formId={formId}
      pending={pending}
      submitLabel={t("withdrawDialog.submit")}
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-8">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="id" value={row.id} />
        <Textarea name="reason" maxLength={1000} width="100%" label={t("withdrawDialog.reason")} />
        <Refusal state={state} />
      </form>
    </DialogShell>
  );
}

function UnsplitButton({ org, row }: { org: string; row: AllocationRowProps }) {
  const t = useCopy("advancing.allocations");
  const { state, pending, submit } = useDialogAction(unsplitAllocationAction, () => undefined);
  return (
    <form onSubmit={submit} className="flex flex-col items-end gap-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="id" value={row.id} />
      <Button type="submit" size="sm" variant="ghost" disabled={pending} aria-busy={pending}>
        {t("actions.unsplit")}
      </Button>
      <Refusal state={state} />
    </form>
  );
}
