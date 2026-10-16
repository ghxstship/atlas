"use client";

/**
 * Create, edit and action controls for Logistics and Hospitality (A11). Forms are declared as field
 * lists by the server page (labels already translated) and submitted to a server action without a
 * form reset, so a refused submit keeps what the person typed. Errors are catalog keys under
 * `logistics.common.errors` and `.fieldErrors`.
 */
import { Button, Drawer, InlineAlert, Input, Select, Textarea, type ButtonProps } from "@xos/ui";
import { useTranslations } from "next-intl";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import type { ActionState } from "@/lib/logistics-hospitality/actions-kit";
import { UndoNotice } from "./client";

type Translate = (key: string, values?: Record<string, string | number>) => string;

function useCopy(namespace: string): Translate {
  const t = useTranslations(namespace as "logistics");
  return (key, values) => (t as unknown as Translate)(key, values);
}

export type FormAction = (state: ActionState, form: FormData) => Promise<ActionState>;

export interface FieldSpec {
  readonly name: string;
  readonly label: string;
  readonly kind: "text" | "textarea" | "select" | "datetime" | "date" | "number" | "money";
  readonly options?: readonly { value: string; label: string }[];
  readonly required?: boolean;
  readonly help?: string;
  readonly defaultValue?: string;
  /** Short hint shown inside an empty text field. */
  readonly hint?: string;
}

/** The refusal or failure of an action, in the module's words. */
export function ActionAlert({ state }: { state: ActionState }) {
  const t = useCopy("logistics.common.errors");
  if (!state.error) return null;
  return (
    <InlineAlert tone="danger" title={t(state.error)}>
      {null}
    </InlineAlert>
  );
}

/** Submits a form's fields to a server action inside a transition, without resetting the form. */
function useSubmit(action: FormAction, onOk?: (state: ActionState) => void) {
  const router = useRouter();
  const [state, setState] = useState<ActionState>({});
  const [pending, startTransition] = useTransition();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const target = e.currentTarget;
    startTransition(async () => {
      const next = await action(state, form);
      setState(next);
      if (next.ok) {
        router.refresh();
        onOk?.(next);
        if (!onOk) target.reset();
      }
    });
  };
  return { state, pending, onSubmit };
}

function Fields({
  prefix,
  fields,
  state,
}: {
  prefix: string;
  fields: readonly FieldSpec[];
  state: ActionState;
}) {
  const fe = useCopy("logistics.common.fieldErrors");
  return (
    <>
      {fields.map((f) => {
        const id = `${prefix}-${f.name}`;
        const errorKey = state.fieldErrors?.[f.name];
        const error = errorKey ? fe(errorKey) : "";
        const common = {
          id,
          name: f.name,
          label: f.label,
          ...(f.help ? { help: f.help } : {}),
        };
        if (f.kind === "select") {
          return (
            <Select
              key={f.name}
              {...common}
              {...(error ? { error } : {})}
              value={f.defaultValue ?? ""}
              options={[...(f.options ?? [])]}
            />
          );
        }
        if (f.kind === "textarea") {
          return (
            <Textarea
              key={f.name}
              {...common}
              {...(error ? { error } : {})}
              width="100%"
              rows={3}
              required={f.required}
              defaultValue={f.defaultValue}
            />
          );
        }
        const type =
          f.kind === "datetime"
            ? "datetime-local"
            : f.kind === "date"
              ? "date"
              : f.kind === "number"
                ? "number"
                : "text";
        return (
          <Input
            key={f.name}
            {...common}
            {...(error ? { error } : {})}
            type={type}
            width="100%"
            required={f.required}
            defaultValue={f.defaultValue}
            {...(f.kind === "money" ? { inputMode: "decimal" as const } : {})}
            {...(f.kind === "number" ? { min: 0, step: "any" } : {})}
            {...(f.hint ? { placeholder: f.hint } : {})}
          />
        );
      })}
    </>
  );
}

function Hidden({ values }: { values: Readonly<Record<string, string>> }) {
  return (
    <>
      {Object.entries(values).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

/**
 * A create or edit form in a drawer, opened by the URL (`?create=1`, `&edit=1`). Closing returns to
 * `closeHref`; a success opens `successHref` with `{key}` replaced by the saved row's display key.
 */
export function FormDrawer({
  title,
  fields,
  hidden,
  action,
  submitLabel,
  closeHref,
  successHref,
}: {
  title: string;
  fields: readonly FieldSpec[];
  hidden: Readonly<Record<string, string>>;
  action: FormAction;
  submitLabel: string;
  closeHref: string;
  successHref?: string;
}) {
  const router = useRouter();
  const t = useCopy("logistics.common");
  const formId = useId();
  const { state, pending, onSubmit } = useSubmit(action, (next) => {
    // The token may arrive URL-encoded when the server built the href with URLSearchParams.
    const href =
      successHref && next.key
        ? successHref.replace(/\{key\}|%7Bkey%7D/, encodeURIComponent(next.key))
        : closeHref;
    router.push(href as Route, { scroll: false });
  });
  return (
    <Drawer
      open
      title={title}
      onClose={() => router.push(closeHref as Route, { scroll: false })}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => router.push(closeHref as Route, { scroll: false })}
          >
            {t("cancel")}
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} className="flex flex-col gap-16" noValidate onSubmit={onSubmit}>
        <Hidden values={hidden} />
        <ActionAlert state={state} />
        <Fields prefix={formId} fields={fields} state={state} />
      </form>
    </Drawer>
  );
}

/** A short form inside a record page or list, such as a manifest line or a yard entry. */
export function InlineForm({
  label,
  fields,
  hidden,
  action,
  submitLabel,
}: {
  label: string;
  fields: readonly FieldSpec[];
  hidden: Readonly<Record<string, string>>;
  action: FormAction;
  submitLabel: string;
}) {
  const formId = useId();
  const { state, pending, onSubmit } = useSubmit(action);
  return (
    <form
      aria-label={label}
      className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
      noValidate
      onSubmit={onSubmit}
    >
      <Hidden values={hidden} />
      <ActionAlert state={state} />
      <div className="grid gap-8 sm:grid-cols-2">
        <Fields prefix={formId} fields={fields} state={state} />
      </div>
      <div>
        <Button type="submit" size="sm" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * One action on a record, such as Check in, Release or Approve. With `undo`, a success shows an
 * Undo toast for 8 seconds instead of asking for confirmation (Section 11.7).
 */
export function ActionButton({
  label,
  run,
  variant = "secondary",
  icon,
  undo,
  doneHref,
}: {
  label: string;
  run: () => Promise<ActionState>;
  variant?: ButtonProps["variant"];
  icon?: string;
  undo?: { message: string; restore: () => Promise<ActionState> };
  /** Where to go after a success, for example back to the list after a delete. */
  doneHref?: string;
}) {
  const router = useRouter();
  const tc = useCopy("logistics.common");
  const [state, setState] = useState<ActionState>({});
  const [undoable, setUndoable] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-flex flex-col gap-4">
      <Button
        size="sm"
        variant={variant}
        loading={pending}
        {...(icon ? { icon } : {})}
        onClick={() =>
          startTransition(async () => {
            const next = await run();
            setState(next);
            if (next.ok) {
              if (undo) setUndoable(true);
              if (doneHref) router.push(doneHref as Route, { scroll: false });
              else router.refresh();
            }
          })
        }
      >
        {label}
      </Button>
      <ActionAlert state={state} />
      <UndoNotice
        region={tc("undoRegion")}
        message={undo && undoable ? undo.message : null}
        onUndo={() =>
          startTransition(async () => {
            if (!undo) return;
            const restored = await undo.restore();
            setState(restored);
            setUndoable(false);
            router.refresh();
          })
        }
      />
    </span>
  );
}

/** A state move with its required reason, offering only the moves the lifecycle allows. */
export function TransitionForm({
  formLabel,
  label,
  moves,
  reasonLabel,
  submitLabel,
  run,
}: {
  /** Names the form for assistive technology, apart from the state field's label. */
  formLabel: string;
  label: string;
  moves: readonly { value: string; label: string }[];
  reasonLabel: string;
  submitLabel: string;
  run: (next: string, reason: string) => Promise<ActionState>;
}) {
  const router = useRouter();
  const id = useId();
  const [next, setNext] = useState(moves[0]?.value ?? "");
  const [reason, setReason] = useState("");
  const [state, setState] = useState<ActionState>({});
  const [pending, startTransition] = useTransition();
  if (moves.length === 0) return null;
  return (
    <form
      aria-label={formLabel}
      className="flex flex-col gap-8"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await run(next, reason);
          setState(result);
          if (result.ok) {
            setReason("");
            router.refresh();
          }
        });
      }}
    >
      <ActionAlert state={state} />
      <div className="flex flex-wrap items-end gap-8">
        <Select
          id={`${id}-next`}
          label={label}
          value={next}
          options={[...moves]}
          onChange={(e) => setNext(e.target.value)}
        />
        <Input
          id={`${id}-reason`}
          label={reasonLabel}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
        <Button type="submit" size="sm" loading={pending} disabled={reason.trim() === ""}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
