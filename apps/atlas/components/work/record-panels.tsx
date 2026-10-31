"use client";

import type {
  Assignment,
  CanonOption,
  ChecklistItem,
  ExtensionValues,
  PersonRef,
  RecordSummary,
  Recurrence,
  ScopeNodeRef,
} from "@xos/data/work";
import {
  Button,
  Checkbox,
  Drawer,
  IconButton,
  Input,
  MoreFields,
  Select,
  Textarea,
  ToastRegion,
  UndoToast,
} from "@xos/ui";
import type { Route } from "next";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { undoStack, type UndoResult } from "@xos/ui/undo";
import type { ActionResult } from "./action-result";
import { ActionErrorAlert, useAction, useCopy } from "./action-ui";
import {
  addChecklistItemAction,
  assignAction,
  checkItemAction,
  removeChecklistItemAction,
  restoreRecordAction,
  saveExtensionAction,
  setRecurrenceAction,
  transitionRecordAction,
  trashRecordAction,
  unassignAction,
  updateRecordAction,
  watchAction,
} from "./actions";
import { fromLocalInput, toLocalInput } from "./format";
import { duplicateRecordAction } from "./work-order-actions";
import { describeRrule } from "@/lib/work/recurrence-text";

/*
 * The interactive parts of a record's peek and full page (Record template, Section 11.6): state
 * moves, editing, checklist, assignees, watching, recurrence, the kind's own attributes and Trash.
 * Each control calls one server action; refusals show the catalog sentence and the database's
 * correction where it gives one, and the route refreshes after a success.
 */

// State moves ---------------------------------------------------------------------------------------------

/** The states a record may move to, as buttons that open the move form. */
export function TransitionControls({
  org,
  record,
  next,
}: {
  org: string;
  record: RecordSummary;
  next: readonly string[];
}) {
  const t = useCopy("work");
  const [target, setTarget] = useState<string | null>(null);
  if (next.length === 0) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("transition.none")}</p>;
  }
  return (
    <div className="flex flex-col gap-8">
      <h3 className="m-0 text-label-13 font-semibold">{t("transition.title")}</h3>
      <div className="flex flex-wrap gap-6">
        {next.map((state) => (
          <Button key={state} size="sm" onClick={() => setTarget(state)}>
            {t("transition.to", { state: t(`states.${state}`) })}
          </Button>
        ))}
      </div>
      {target ? (
        <TransitionDialog org={org} record={record} next={target} onClose={() => setTarget(null)} />
      ) : null}
    </div>
  );
}

/** The move form: a reason always, a blocker for Blocked and a replan reason for Deferred. */
export function TransitionDialog({
  org,
  record,
  next,
  onClose,
}: {
  org: string;
  record: RecordSummary;
  next: string;
  onClose: () => void;
}) {
  const t = useCopy("work");
  const { pending, error, run } = useAction();
  const [reason, setReason] = useState("");
  const [blocker, setBlocker] = useState("");
  const [replan, setReplan] = useState("");
  const needsBlocker = next === "Blocked";
  const needsReplan = next === "Deferred";
  const ready =
    reason.trim() !== "" &&
    (!needsBlocker || blocker.trim() !== "") &&
    (!needsReplan || replan.trim() !== "");
  return (
    <Drawer
      title={t("transition.dialogTitle", { key: record.key, state: t(`states.${next}`) })}
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("actions.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!ready}
            onClick={() =>
              run(
                () =>
                  transitionRecordAction(org, {
                    recordId: record.id,
                    expected: record.state,
                    next,
                    reason,
                    blockerText: needsBlocker ? blocker : null,
                    replanReason: needsReplan ? replan : null,
                  }),
                onClose,
              )
            }
          >
            {t("transition.submit")}
          </Button>
        </>
      }
    >
      <ActionErrorAlert error={error} />
      <Textarea
        id="transition-reason"
        label={t("transition.reason")}
        help={t("transition.reasonHelp")}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {needsBlocker ? (
        <Textarea
          id="transition-blocker"
          label={t("transition.blocker")}
          help={t("transition.blockerHelp")}
          value={blocker}
          onChange={(e) => setBlocker(e.target.value)}
        />
      ) : null}
      {needsReplan ? (
        <Textarea
          id="transition-replan"
          label={t("transition.replan")}
          help={t("transition.replanHelp")}
          value={replan}
          onChange={(e) => setReplan(e.target.value)}
        />
      ) : null}
    </Drawer>
  );
}

// Editing ------------------------------------------------------------------------------------------------

/** Edits the record's shared fields. From Scheduled onward, date changes ask for a replan reason. */
export function EditRecordForm({
  org,
  record,
  subtypes,
  people,
  scopeNodes,
  phases,
  logsReplans,
}: {
  org: string;
  record: RecordSummary;
  subtypes: readonly string[];
  people: readonly PersonRef[];
  scopeNodes: readonly ScopeNodeRef[];
  phases: readonly (CanonOption & { gate: number })[];
  logsReplans: boolean;
}) {
  const t = useCopy("work");
  const tz = record.timeZone ?? record.projectTimeZone;
  const { pending, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const [title, setTitle] = useState(record.title);
  const [subtype, setSubtype] = useState(record.subtype ?? "");
  const [owner, setOwner] = useState(record.ownerId ?? "");
  const [accountable, setAccountable] = useState(record.accountableId ?? "");
  const [scope, setScope] = useState(record.scopeNodeId ?? "");
  const [phase, setPhase] = useState(record.phaseCode ?? "");
  const [replan, setReplan] = useState("");
  const personOptions = [
    { value: "", label: t("values.unassigned") },
    ...people.map((p) => ({ value: p.personId, label: p.name ?? t("values.unnamed") })),
  ];
  return (
    <form
      aria-label={t("edit.title")}
      className="flex flex-col gap-12"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        // Dates are read from the form: native date inputs keep their own value.
        const form = new FormData(e.currentTarget);
        const value = (name: string) => {
          const v = form.get(name);
          return typeof v === "string" ? v : "";
        };
        const starts = value("startsAt");
        const ends = value("endsAt");
        const due = value("dueAt");
        const datesChanged =
          starts !== toLocalInput(record.startsAt, tz) ||
          ends !== toLocalInput(record.endsAt, tz) ||
          due !== toLocalInput(record.dueAt, tz);
        run(
          () =>
            updateRecordAction(org, record.id, {
              title,
              subtype: subtype || null,
              ownerId: owner || null,
              accountableId: accountable || null,
              scopeNodeId: scope || null,
              phaseCode: phase || null,
              startsAt: fromLocalInput(starts, tz),
              endsAt: fromLocalInput(ends, tz),
              dueAt: fromLocalInput(due, tz),
              ...(logsReplans && datesChanged && replan.trim() !== ""
                ? { replanReason: replan }
                : {}),
            }),
          () => {
            setSaved(true);
            setReplan("");
          },
        );
      }}
    >
      <h3 className="m-0 text-label-13 font-semibold">{t("edit.title")}</h3>
      <ActionErrorAlert error={error} />
      <Input
        id="edit-title"
        label={t("fields.title")}
        help={t("fields.titleHelp", { kind: t(`kinds.${record.kind}`) })}
        value={title}
        width="100%"
        onChange={(e) => setTitle(e.target.value)}
      />
      {subtypes.length > 0 ? (
        <Select
          id="edit-subtype"
          label={t("fields.subtype")}
          value={subtype}
          options={[
            { value: "", label: t("values.none") },
            ...subtypes.map((s) => ({ value: s, label: t(`subtypes.${record.kind}.${s}`) })),
          ]}
          onChange={(e) => setSubtype(e.target.value)}
        />
      ) : null}
      <div className="grid grid-cols-2 gap-12 max-sm:grid-cols-1">
        <Select
          id="edit-owner"
          label={t("fields.owner")}
          value={owner}
          options={personOptions}
          onChange={(e) => setOwner(e.target.value)}
        />
        <Select
          id="edit-phase"
          label={t("fields.phase")}
          value={phase}
          options={[
            { value: "", label: t("values.none") },
            ...phases.map((p) => ({
              value: p.value,
              label: t("values.gate", { gate: p.gate, name: p.label }),
            })),
          ]}
          onChange={(e) => setPhase(e.target.value)}
        />
        <Input
          id="edit-starts"
          type="datetime-local"
          label={t("fields.starts")}
          name="startsAt"
          defaultValue={toLocalInput(record.startsAt, tz)}
        />
        <Input
          id="edit-ends"
          type="datetime-local"
          label={t("fields.ends")}
          name="endsAt"
          defaultValue={toLocalInput(record.endsAt, tz)}
        />
      </div>
      <MoreFields>
        <div className="grid grid-cols-2 gap-12 max-sm:grid-cols-1">
          <Select
            id="edit-accountable"
            label={t("fields.accountable")}
            value={accountable}
            options={personOptions}
            onChange={(e) => setAccountable(e.target.value)}
          />
          <Select
            id="edit-scope"
            label={t("fields.scope")}
            value={scope}
            options={[
              { value: "", label: t("values.none") },
              ...scopeNodes.map((n) => ({ value: n.id, label: n.name })),
            ]}
            onChange={(e) => setScope(e.target.value)}
          />
          <Input
            id="edit-due"
            type="datetime-local"
            label={t("fields.due")}
            name="dueAt"
            defaultValue={toLocalInput(record.dueAt, tz)}
          />
        </div>
      </MoreFields>
      <p className="m-0 text-text-12 text-text-secondary">{t("fields.zoneNote", { zone: tz })}</p>
      {logsReplans ? (
        <Textarea
          id="edit-replan"
          label={t("fields.replanReason")}
          help={t("fields.replanHelp")}
          value={replan}
          onChange={(e) => setReplan(e.target.value)}
        />
      ) : null}
      <div className="flex items-center gap-12">
        <Button type="submit" loading={pending}>
          {t("actions.save")}
        </Button>
        {saved ? (
          <p role="status" className="m-0 text-text-13 text-success-text">
            {t("edit.saved")}
          </p>
        ) : null}
      </div>
    </form>
  );
}

// Checklist ----------------------------------------------------------------------------------------------

export function ChecklistEditor({
  org,
  recordId,
  items,
  canEdit,
}: {
  org: string;
  recordId: string;
  items: readonly ChecklistItem[];
  canEdit: boolean;
}) {
  const t = useCopy("work");
  const { pending, error, run } = useAction();
  const [label, setLabel] = useState("");
  const done = items.filter((i) => i.checkedAt !== null).length;
  return (
    <section aria-labelledby={`checklist-${recordId}`} className="flex flex-col gap-8">
      <h3 id={`checklist-${recordId}`} className="m-0 text-label-13 font-semibold">
        {t("checklist.title")}{" "}
        {items.length > 0 ? (
          <span className="font-normal text-text-secondary">
            {t("checklist.progress", { done, total: items.length })}
          </span>
        ) : null}
      </h3>
      <ActionErrorAlert error={error} />
      {items.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {canEdit ? t("checklist.empty") : t("checklist.emptyReadOnly")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-8">
              <Checkbox
                label={item.label}
                checked={item.checkedAt !== null}
                disabled={!canEdit || pending}
                onChange={(e) => run(() => checkItemAction(org, item.id, e.target.checked))}
              />
              {canEdit ? (
                <IconButton
                  icon="X"
                  label={t("checklist.remove", { label: item.label })}
                  onClick={() => run(() => removeChecklistItemAction(org, item.id))}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <form
          className="flex items-end gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => addChecklistItemAction(org, recordId, label),
              () => setLabel(""),
            );
          }}
        >
          <Input
            id={`checklist-new-${recordId}`}
            label={t("checklist.add")}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button type="submit" disabled={label.trim() === ""} loading={pending}>
            {t("checklist.addButton")}
          </Button>
        </form>
      ) : null}
    </section>
  );
}

// Assignees and watching ---------------------------------------------------------------------------------

export function AssignmentsEditor({
  org,
  recordId,
  assignments,
  people,
  canEdit,
}: {
  org: string;
  recordId: string;
  assignments: readonly Assignment[];
  people: readonly PersonRef[];
  canEdit: boolean;
}) {
  const t = useCopy("work");
  const { pending, error, run } = useAction();
  const [choice, setChoice] = useState("");
  const assigned = new Set(assignments.map((a) => a.membershipId));
  const available = people.filter((p) => !assigned.has(p.membershipId));
  return (
    <section aria-labelledby={`assignees-${recordId}`} className="flex flex-col gap-8">
      <h3 id={`assignees-${recordId}`} className="m-0 text-label-13 font-semibold">
        {t("assignees.title")}
      </h3>
      <ActionErrorAlert error={error} />
      {assignments.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("assignees.empty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-6 p-0">
          {assignments.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-4 rounded-chip bg-bg-hover px-8 py-2 text-text-13"
            >
              {a.name ?? t("values.unnamed")}
              {canEdit ? (
                <IconButton
                  icon="X"
                  label={t("assignees.remove", { name: a.name ?? t("values.unnamed") })}
                  onClick={() => run(() => unassignAction(org, a.id))}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit && available.length > 0 ? (
        <div className="flex items-end gap-6">
          <Select
            key={assignments.length}
            id={`assign-${recordId}`}
            label={t("assignees.add")}
            value=""
            placeholder={t("assignees.choose")}
            options={available.map((p) => ({
              value: p.membershipId,
              label: p.name ?? t("values.unnamed"),
            }))}
            onChange={(e) => setChoice(e.target.value)}
          />
          <Button
            disabled={choice === ""}
            loading={pending}
            onClick={() =>
              run(
                () => assignAction(org, recordId, choice),
                () => setChoice(""),
              )
            }
          >
            {t("assignees.addButton")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function WatchButton({
  org,
  recordId,
  watchId,
}: {
  org: string;
  recordId: string;
  watchId: string | null;
}) {
  const t = useCopy("work");
  const { pending, error, run } = useAction();
  return (
    <div className="flex flex-col gap-4">
      <Button
        size="sm"
        icon={watchId ? "EyeOff" : "Eye"}
        loading={pending}
        onClick={() => run(() => watchAction(org, recordId, watchId))}
      >
        {watchId ? t("watch.stop") : t("watch.start")}
      </Button>
      <ActionErrorAlert error={error} />
    </div>
  );
}

// Recurrence ---------------------------------------------------------------------------------------------

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

export function RecurrenceForm({
  org,
  record,
  recurrence,
  canEdit,
}: {
  org: string;
  record: RecordSummary;
  recurrence: Recurrence | null;
  canEdit: boolean;
}) {
  const t = useCopy("work");
  const { pending, error, run } = useAction();
  const parts = new Map(
    (recurrence?.rrule ?? "").split(";").map((p) => p.split("=") as [string, string]),
  );
  const [frequency, setFrequency] = useState(parts.get("FREQ") ?? "");
  const [interval, setInterval] = useState(parts.get("INTERVAL") ?? "1");
  const [days, setDays] = useState<string[]>((parts.get("BYDAY") ?? "").split(",").filter(Boolean));
  const tz = record.timeZone ?? record.projectTimeZone;
  const rrule =
    frequency === ""
      ? null
      : [
          `FREQ=${frequency}`,
          Number(interval) > 1 ? `INTERVAL=${Number(interval)}` : null,
          frequency === "WEEKLY" && days.length > 0 ? `BYDAY=${days.join(",")}` : null,
        ]
          .filter(Boolean)
          .join(";");
  return (
    <section aria-labelledby={`recurrence-${record.id}`} className="flex flex-col gap-8">
      <h3 id={`recurrence-${record.id}`} className="m-0 text-label-13 font-semibold">
        {t("recurrence.title")}
      </h3>
      <ActionErrorAlert error={error} />
      {!canEdit ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {recurrence
            ? t("recurrence.rule", {
                rule: describeRrule(recurrence.rrule, (key, values) =>
                  t(`recurrence.${key}`, values),
                ),
              })
            : t("recurrence.none")}
        </p>
      ) : (
        <form
          className="flex flex-col gap-8"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => setRecurrenceAction(org, { recordId: record.id, rrule, timeZone: tz }));
          }}
        >
          <div className="flex flex-wrap items-end gap-8">
            <Select
              id={`recurrence-frequency-${record.id}`}
              label={t("recurrence.frequency")}
              value={frequency}
              options={[
                { value: "", label: t("recurrence.never") },
                { value: "DAILY", label: t("recurrence.daily") },
                { value: "WEEKLY", label: t("recurrence.weekly") },
                { value: "MONTHLY", label: t("recurrence.monthly") },
              ]}
              onChange={(e) => setFrequency(e.target.value)}
            />
            {frequency !== "" ? (
              <Input
                id={`recurrence-interval-${record.id}`}
                type="number"
                min={1}
                max={52}
                width={96}
                label={t("recurrence.interval")}
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              />
            ) : null}
          </div>
          {frequency === "WEEKLY" ? (
            <fieldset className="m-0 flex flex-wrap gap-8 border-0 p-0">
              <legend className="mb-4 text-text-13 font-medium">{t("recurrence.days")}</legend>
              {WEEKDAYS.map((d) => (
                <Checkbox
                  key={d}
                  label={t(`recurrence.weekday.${d}`)}
                  checked={days.includes(d)}
                  onChange={(e) =>
                    setDays(e.target.checked ? [...days, d] : days.filter((x) => x !== d))
                  }
                />
              ))}
            </fieldset>
          ) : null}
          <p className="m-0 text-text-12 text-text-secondary">
            {t("recurrence.zone", { zone: tz })}
          </p>
          <div>
            <Button type="submit" loading={pending}>
              {rrule ? t("recurrence.save") : t("recurrence.clear")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

// Kind attributes ----------------------------------------------------------------------------------------

export type FieldType =
  | "text"
  | "longText"
  | "number"
  | "datetime"
  | "date"
  | "boolean"
  | "person"
  | "money"
  | "currency"
  | "select"
  | "readonly";

export interface KindField {
  readonly column: string;
  readonly type: FieldType;
  /** For select fields: the options, loaded from canon or the org. */
  readonly options?: readonly CanonOption[];
  /** For money fields: the column holding its currency. */
  readonly currencyColumn?: string;
}

/** Edits the kind's own attributes (the record's 1:1 extension row). */
export function ExtensionForm({
  org,
  record,
  fields,
  values,
  people,
  currencies,
  canEdit,
}: {
  org: string;
  record: RecordSummary;
  fields: readonly KindField[];
  values: ExtensionValues;
  people: readonly PersonRef[];
  currencies: readonly { code: string; exponent: number }[];
  canEdit: boolean;
}) {
  const t = useCopy("work");
  const locale = useLocale();
  const exponentFor = (f: KindField, currency: unknown) =>
    currencies.find((c) => c.code === (typeof currency === "string" ? currency : ""))?.exponent ??
    (f.currencyColumn ? 2 : 0);
  const tz = record.timeZone ?? record.projectTimeZone;
  const { pending, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      fields.map((f) => {
        const v = values[f.column];
        if (f.type === "boolean") return [f.column, v === true];
        if (f.type === "datetime")
          return [f.column, toLocalInput(typeof v === "string" ? v : null, tz)];
        if (f.type === "money") {
          const exp = exponentFor(f, f.currencyColumn ? values[f.currencyColumn] : null);
          return [f.column, typeof v === "number" ? String(v / 10 ** exp) : ""];
        }
        return [f.column, v === null || v === undefined ? "" : String(v)];
      }),
    ),
  );
  if (fields.length === 0) return null;
  const label = (column: string) => t(`extension.${column}`);
  const set = (column: string, value: string | boolean) =>
    setDraft((d) => ({ ...d, [column]: value }));
  const toValue = (f: KindField): string | number | boolean | null => {
    const v = draft[f.column];
    if (f.type === "boolean") return v === true;
    if (typeof v !== "string" || v.trim() === "") return null;
    if (f.type === "number") return Number(v);
    if (f.type === "money") {
      const exp = exponentFor(f, f.currencyColumn ? draft[f.currencyColumn] : null);
      return Math.round(Number(v) * 10 ** exp);
    }
    if (f.type === "datetime") return fromLocalInput(v, tz);
    return v.trim();
  };
  const editable = fields.filter((f) => f.type !== "readonly");
  return (
    <form
      aria-label={t("extension.title", { kind: t(`kinds.${record.kind}`) })}
      className="flex flex-col gap-12"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        run(
          () =>
            saveExtensionAction(org, {
              recordId: record.id,
              kind: record.kind,
              fields: Object.fromEntries(editable.map((f) => [f.column, toValue(f)])),
            }),
          () => setSaved(true),
        );
      }}
    >
      <h3 className="m-0 text-label-13 font-semibold">
        {t("extension.title", { kind: t(`kinds.${record.kind}`) })}
      </h3>
      <ActionErrorAlert error={error} />
      <div className="grid grid-cols-2 gap-12 max-sm:grid-cols-1">
        {fields.map((f) => {
          const id = `ext-${record.id}-${f.column}`;
          const value = draft[f.column];
          const text = typeof value === "string" ? value : "";
          const disabled = !canEdit;
          switch (f.type) {
            case "readonly": {
              const raw = values[f.column];
              return (
                <p key={f.column} className="m-0 flex flex-col gap-2 text-text-13">
                  <span className="font-medium">{label(f.column)}</span>
                  <span className="text-text-secondary">
                    {raw === null || raw === undefined ? t("values.notSet") : String(raw)}
                  </span>
                </p>
              );
            }
            case "boolean":
              return (
                <Checkbox
                  key={f.column}
                  label={label(f.column)}
                  checked={value === true}
                  disabled={disabled}
                  onChange={(e) => set(f.column, e.target.checked)}
                />
              );
            case "longText":
              return (
                <Textarea
                  key={f.column}
                  id={id}
                  label={label(f.column)}
                  value={text}
                  disabled={disabled}
                  onChange={(e) => set(f.column, e.target.value)}
                />
              );
            case "person":
              return (
                <Select
                  key={f.column}
                  id={id}
                  label={label(f.column)}
                  value={text}
                  disabled={disabled}
                  options={[
                    { value: "", label: t("values.notSet") },
                    ...people.map((p) => ({
                      value: p.personId,
                      label: p.name ?? t("values.unnamed"),
                    })),
                  ]}
                  onChange={(e) => set(f.column, e.target.value)}
                />
              );
            case "currency":
              return (
                <Select
                  key={f.column}
                  id={id}
                  label={label(f.column)}
                  value={text}
                  disabled={disabled}
                  options={[
                    { value: "", label: t("values.notSet") },
                    ...currencies.map((c) => ({ value: c.code, label: c.code })),
                  ]}
                  onChange={(e) => set(f.column, e.target.value)}
                />
              );
            case "select":
              return (
                <Select
                  key={f.column}
                  id={id}
                  label={label(f.column)}
                  value={text}
                  disabled={disabled}
                  options={[
                    { value: "", label: t("values.notSet") },
                    ...(f.options ?? []).map((o) => ({
                      value: o.value,
                      label: o.code && o.code !== o.label ? `${o.label} · ${o.code}` : o.label,
                    })),
                  ]}
                  onChange={(e) => set(f.column, e.target.value)}
                />
              );
            case "money":
              return (
                <Input
                  key={f.column}
                  id={id}
                  type="number"
                  step="0.01"
                  min={0}
                  label={label(f.column)}
                  {...(text === "" ? { help: t("values.unpriced") } : {})}
                  value={text}
                  disabled={disabled}
                  lang={locale}
                  onChange={(e) => set(f.column, e.target.value)}
                />
              );
            default:
              return (
                <Input
                  key={f.column}
                  id={id}
                  type={
                    f.type === "number"
                      ? "number"
                      : f.type === "datetime"
                        ? "datetime-local"
                        : f.type === "date"
                          ? "date"
                          : "text"
                  }
                  label={label(f.column)}
                  value={text}
                  disabled={disabled}
                  onChange={(e) => set(f.column, e.target.value)}
                />
              );
          }
        })}
      </div>
      {canEdit && editable.length > 0 ? (
        <div className="flex items-center gap-12">
          <Button type="submit" loading={pending}>
            {t("actions.save")}
          </Button>
          {saved ? (
            <p role="status" className="m-0 text-text-13 text-success-text">
              {t("edit.saved")}
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

// Trash ----------------------------------------------------------------------------------------------------

/**
 * Moves a record to Trash with an 8-second Undo (Section 11.7), or restores one from Trash. The Undo
 * toast stays in the same place whichever control shows: the trash action returns the refreshed
 * record with it, already in Trash, and a toast inside the not-trashed branch unmounted before it
 * was ever seen (journey 70, A71).
 */
export function TrashControls({
  org,
  record,
  onTrashed,
}: {
  org: string;
  record: RecordSummary;
  onTrashed?: () => void;
}) {
  const t = useCopy("work");
  const { pending, error, run } = useAction();
  // The undo stack entry the toast shows (Section 11.7): Cmd or Ctrl+Z and the toast's Undo restore
  // through the same entry, and redo moves the record back to Trash.
  const [undo, setUndo] = useState<number | null>(null);
  useEffect(
    () =>
      undoStack.subscribe((event) => {
        if (event.kind === "undone" && event.entry.id === undo) setUndo(null);
      }),
    [undo],
  );
  const asUndo = async (action: () => Promise<ActionResult>): Promise<UndoResult> => {
    const result = await action();
    return result.ok ? { ok: true } : { ok: false, message: t(`errors.${result.error.key}`) };
  };
  const trashed = () =>
    setUndo(
      undoStack.push({
        label: t("trash.moved", { key: record.key }),
        toast: false,
        undo: () => asUndo(() => restoreRecordAction(org, record.id)),
        redo: () => asUndo(() => trashRecordAction(org, record.id)),
      }).id,
    );
  return (
    <div className="flex flex-col gap-6">
      {record.deletedAt ? (
        <>
          <p className="m-0 text-text-13 text-text-secondary">{t("trash.inTrash")}</p>
          <div>
            <Button
              loading={pending}
              onClick={() =>
                run(
                  () => restoreRecordAction(org, record.id),
                  () => setUndo(null),
                )
              }
            >
              {t("trash.restore")}
            </Button>
          </div>
        </>
      ) : (
        <div>
          <Button
            variant="ghost"
            icon="Trash2"
            loading={pending}
            onClick={() => run(() => trashRecordAction(org, record.id), trashed)}
          >
            {t("trash.move")}
          </Button>
        </div>
      )}
      <ActionErrorAlert error={error} />
      <ToastRegion label={t("trash.notifications")}>
        {undo !== null ? (
          <UndoToast
            message={t("trash.moved", { key: record.key })}
            onUndo={() => void undoStack.undo(undo)}
            onExpire={() => {
              setUndo(null);
              onTrashed?.();
            }}
          />
        ) : null}
      </ToastRegion>
    </div>
  );
}

/** Copies the record and its checklist into a new Proposed record, then opens the copy (journey 70). */
export function DuplicateButton({ org, recordId }: { org: string; recordId: string }) {
  const t = useCopy("work");
  const router = useRouter();
  const { pending, error, run } = useAction();
  const duplicate = (withoutDates: boolean) =>
    run(
      () => duplicateRecordAction(org, recordId, { withoutDates }),
      (data) => router.push(`/${org}/r/${data.key}` as Route),
    );
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-6">
        <Button variant="ghost" icon="Copy" loading={pending} onClick={() => duplicate(false)}>
          {t("duplicate.button")}
        </Button>
        {/* P8: the copy waits in the schedule's Unscheduled list. */}
        <Button variant="ghost" icon="Copy" loading={pending} onClick={() => duplicate(true)}>
          {t("duplicate.withoutDates")}
        </Button>
      </div>
      <ActionErrorAlert error={error} />
    </div>
  );
}
