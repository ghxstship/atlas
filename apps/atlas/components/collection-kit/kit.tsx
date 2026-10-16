"use client";

import {
  Button,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  InlineAlert,
  Input,
  PropertyList,
  Select,
  StateChip,
  TemplateRecord,
  Textarea,
  buttonClass,
  type ButtonProps,
} from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { keepInputOnSubmit, useResetOnSuccess } from "./keep-input";
import { useCopy } from "./use-copy";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import type { ActionState } from "@/lib/collection-kit/forms";
import type { KitState } from "./types";

/**
 * Client building blocks of the A16 pages: the side peek, the full record page, the generic form,
 * lifecycle and one-click actions with a required reason, refusal feedback, and the error and
 * blocked states. Every string comes from the catalogs (`procurement.kit` and the module's
 * `refusals`), every action is a server action that row level security and the A03 RPCs decide.
 */

type ServerAction = (state: ActionState, form: FormData) => Promise<ActionState>;

const INITIAL: ActionState = {};

function hiddenInputs(hidden: Readonly<Record<string, string>>) {
  return Object.entries(hidden).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ));
}

/** A link styled as a button. */
export function KitLink({
  href,
  variant = "secondary",
  size = "md",
  children,
}: {
  href: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  children: ReactNode;
}) {
  return (
    <NextLink href={href as Route} className={buttonClass(variant ?? "secondary", size ?? "md")}>
      {children}
    </NextLink>
  );
}

/** Explains an action's outcome: a named refusal, a conflict, a missing row or a field problem. */
export function ActionFeedback({
  state,
  refusals,
}: {
  state: ActionState;
  /** Namespace holding the module's refusal copy, for example `procurement.refusals`. */
  refusals: string;
}) {
  const kit = useCopy("procurement.kit");
  const r = useCopy(refusals);
  if (state.rule) {
    const key = r.has(state.rule) ? state.rule : null;
    return (
      <InlineAlert tone="warning" title={kit("refusedTitle")}>
        {key ? r(key) : kit(`refusalFamily.${familyOf(state.rule)}`)}
        <span className="block font-mono text-text-11 text-text-tertiary">{state.rule}</span>
      </InlineAlert>
    );
  }
  if (state.error) {
    return <InlineAlert tone="danger">{kit(`errors.${state.error}`)}</InlineAlert>;
  }
  if (state.fieldErrors && Object.keys(state.fieldErrors).length > 0) {
    return <InlineAlert tone="danger">{kit("errors.fields")}</InlineAlert>;
  }
  return null;
}

function familyOf(rule: string): string {
  if (rule.endsWith("_transition_not_allowed")) return "transition";
  if (rule.endsWith("_state_conflict")) return "conflict";
  if (rule.startsWith("sod_")) return "separation";
  if (rule.startsWith("spend_")) return "spend";
  return "other";
}

// Peek and record page ----------------------------------------------------------------------------

/** The side peek of a domain entity (Section 11.6 Record anatomy in a drawer; full screen below md). */
export function PeekDrawer({
  recordKey,
  title,
  state,
  properties,
  closeHref,
  fullHref,
  actions,
  children,
}: {
  recordKey: string;
  title: string;
  state?: KitState;
  properties: { label: string; value: ReactNode }[];
  closeHref: string;
  fullHref: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const t = useCopy("procurement.kit");
  const router = useRouter();
  return (
    <Drawer
      title={`${recordKey} ${title}`}
      open
      onOpenChange={(open) => {
        if (!open) router.push(closeHref as Route, { scroll: false });
      }}
      footer={<KitLink href={fullHref}>{t("openFull")}</KitLink>}
    >
      <div className="flex flex-wrap items-center gap-8">
        {state ? <StateChip state={state.state} label={state.label} /> : null}
        {actions}
      </div>
      <PropertyList items={properties} />
      {children}
    </Drawer>
  );
}

/** The full record page: key, title and state, content beside the 320 px property column. */
export function RecordPage({
  backHref,
  backLabel,
  recordKey,
  title,
  state,
  properties,
  actions,
  children,
  related,
}: {
  backHref: string;
  backLabel: string;
  recordKey: string;
  title: string;
  state?: KitState;
  properties: { label: string; value: ReactNode }[];
  actions?: ReactNode;
  children?: ReactNode;
  related?: ReactNode;
}) {
  const t = useCopy("procurement.kit");
  return (
    <TemplateRecord
      propertiesLabel={t("properties")}
      header={
        <header className="flex flex-col gap-8 pb-12 border-b border-border-subtle">
          <NextLink href={backHref as Route} className="text-text-12 text-text-secondary">
            {backLabel}
          </NextLink>
          <div className="flex flex-wrap items-center justify-between gap-12">
            <div className="flex flex-wrap items-center gap-8 min-w-0">
              <span className="font-mono text-text-12 text-text-secondary">{recordKey}</span>
              <h1 className="m-0 text-heading-20 font-semibold">{title}</h1>
              {state ? <StateChip state={state.state} label={state.label} /> : null}
            </div>
            <div className="flex flex-wrap items-center gap-8">{actions}</div>
          </div>
        </header>
      }
      properties={<PropertyList items={properties} />}
      {...(related ? { related } : {})}
    >
      {children}
    </TemplateRecord>
  );
}

/** A titled section inside a record page or peek. */
export function KitSection({
  id,
  title,
  actions,
  children,
}: {
  id: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <h2 id={`${id}-heading`} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** An empty collection the viewer cannot add to: one sentence and a refresh. */
export function EmptyRefresh({ icon, sentence }: { icon: string; sentence: string }) {
  const t = useCopy("procurement.kit");
  const router = useRouter();
  return (
    <EmptyState
      icon={icon}
      sentence={sentence}
      actionLabel={t("refresh")}
      onAction={() => router.refresh()}
    />
  );
}

/** A failed read: says what failed and offers a retry. */
export function ErrorPanel({ what }: { what: string }) {
  const t = useCopy("procurement.kit.loadError");
  const router = useRouter();
  return (
    <ErrorState
      title={t("title")}
      sentence={t("sentence", { what })}
      actionLabel={t("retry")}
      onRetry={() => router.refresh()}
    />
  );
}

// Forms --------------------------------------------------------------------------------------------

export type FieldSpec =
  | {
      kind: "text" | "number" | "money" | "date" | "datetime" | "url" | "email";
      name: string;
      label: string;
      help?: string;
      required?: boolean;
      defaultValue?: string;
      /** Currency code shown beside a money field. */
      unit?: string;
      readOnly?: boolean;
    }
  | {
      kind: "textarea";
      name: string;
      label: string;
      help?: string;
      required?: boolean;
      defaultValue?: string;
      rows?: number;
    }
  | {
      kind: "select";
      name: string;
      label: string;
      help?: string;
      required?: boolean;
      defaultValue?: string;
      options: { value: string; label: string }[];
      /** Adds a blank first choice with this label. */
      blankLabel?: string;
    }
  | {
      kind: "checkboxes";
      name: string;
      label: string;
      help?: string;
      options: { value: string; label: string }[];
      defaultValues?: string[];
    }
  | {
      kind: "file-checksum";
      name: string;
      label: string;
      help?: string;
      required?: boolean;
    };

const INPUT_TYPE: Record<string, string> = {
  text: "text",
  number: "text",
  money: "text",
  date: "date",
  datetime: "datetime-local",
  url: "url",
  email: "email",
};

/**
 * A form built from field specs and bound to a server action. Typed input survives a failed submit;
 * field errors sit under their fields; a refusal or conflict shows above the fields. On success it
 * navigates to `successHref` (with `{id}` replaced by the created row's id) or refreshes.
 */
export function EntityForm({
  id,
  action,
  fields,
  hidden = {},
  submitLabel,
  refusals,
  successHref,
  onCancelHref,
}: {
  id: string;
  action: ServerAction;
  fields: FieldSpec[];
  hidden?: Readonly<Record<string, string>>;
  submitLabel: string;
  refusals: string;
  successHref?: string;
  onCancelHref?: string;
}) {
  const t = useCopy("procurement.kit");
  const router = useRouter();
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const formRef = useResetOnSuccess(state);
  const done = useRef<ActionState | null>(null);
  useEffect(() => {
    if (state.ok && done.current !== state) {
      done.current = state;
      if (successHref)
        router.push(
          successHref.replace("{id}", state.id ?? "").replace("%7Bid%7D", state.id ?? "") as Route,
        );
      else router.refresh();
    }
  }, [state, successHref, router]);
  const fieldError = (name: string) => {
    const key = state.fieldErrors?.[name];
    return key ? t(`validation.${key}`) : "";
  };
  return (
    <form
      ref={formRef}
      id={id}
      action={formAction}
      onSubmit={keepInputOnSubmit(formAction)}
      className="flex flex-col gap-12"
      noValidate
    >
      {hiddenInputs(hidden)}
      <ActionFeedback state={state} refusals={refusals} />
      {fields.map((f) => {
        const fid = `${id}-${f.name}`;
        const error = fieldError(f.name);
        switch (f.kind) {
          case "textarea":
            return (
              <Textarea
                key={f.name}
                id={fid}
                name={f.name}
                label={f.label}
                width="100%"
                rows={f.rows ?? 4}
                required={f.required}
                defaultValue={f.defaultValue ?? ""}
                {...(f.help ? { help: f.help } : {})}
                error={error}
              />
            );
          case "select":
            return (
              <Select
                key={f.name}
                id={fid}
                name={f.name}
                label={f.label}
                options={f.options}
                {...(f.blankLabel ? { placeholder: f.blankLabel } : {})}
                {...(f.defaultValue !== undefined ? { value: f.defaultValue } : {})}
                {...(f.help ? { help: f.help } : {})}
                error={error}
              />
            );
          case "checkboxes":
            return (
              <fieldset key={f.name} className="flex flex-col gap-6 m-0 p-0 border-0">
                <legend className="mb-4 text-label-13 font-medium">{f.label}</legend>
                {f.options.length === 0 ? (
                  <p className="m-0 text-text-13 text-text-secondary">{f.help}</p>
                ) : (
                  f.options.map((o) => (
                    <label key={o.value} className="flex items-center gap-8 text-text-13">
                      <input
                        type="checkbox"
                        name={f.name}
                        value={o.value}
                        defaultChecked={f.defaultValues?.includes(o.value)}
                      />
                      {o.label}
                    </label>
                  ))
                )}
              </fieldset>
            );
          case "file-checksum":
            return <ChecksumField key={f.name} id={fid} spec={f} error={error} />;
          default:
            return (
              <Input
                key={f.name}
                id={fid}
                name={f.name}
                type={INPUT_TYPE[f.kind] ?? "text"}
                inputMode={f.kind === "money" || f.kind === "number" ? "decimal" : undefined}
                label={f.unit ? `${f.label} (${f.unit})` : f.label}
                width="100%"
                required={f.required}
                readOnly={f.readOnly}
                defaultValue={f.defaultValue ?? ""}
                {...(f.help
                  ? { help: f.help }
                  : f.kind === "money"
                    ? { help: t("moneyHelp") }
                    : {})}
                error={error}
              />
            );
        }
      })}
      <div className="flex flex-wrap items-center gap-8">
        <Button type="submit" variant="primary" loading={pending}>
          {submitLabel}
        </Button>
        {onCancelHref ? <KitLink href={onCancelHref}>{t("cancel")}</KitLink> : null}
        {state.ok ? (
          <p role="status" className="m-0 text-text-13 text-success-text">
            {t("saved")}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** Picks a file, computes its SHA-256 in the browser and submits only the checksum. */
function ChecksumField({
  id,
  spec,
  error,
}: {
  id: string;
  spec: { name: string; label: string; help?: string; required?: boolean };
  error: string;
}) {
  const t = useCopy("procurement.kit");
  const [checksum, setChecksum] = useState("");
  return (
    <div className="flex flex-col gap-4">
      <label htmlFor={id} className="text-label-13 font-medium">
        {spec.label}
      </label>
      <input
        id={id}
        type="file"
        aria-describedby={`${id}-help`}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) {
            setChecksum("");
            return;
          }
          const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
          setChecksum(
            [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
          );
        }}
      />
      <input type="hidden" name={spec.name} value={checksum} />
      <p id={`${id}-help`} className="m-0 text-text-12 text-text-secondary">
        {checksum ? t("checksumReady", { checksum: checksum.slice(0, 12) }) : (spec.help ?? "")}
      </p>
      {error ? (
        <p role="alert" className="m-0 text-text-12 text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A drawer holding a create or edit form, closed by navigating to `closeHref`. */
export function FormDrawer({
  title,
  closeHref,
  children,
}: {
  title: string;
  closeHref: string;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <Drawer
      title={title}
      open
      onOpenChange={(open) => {
        if (!open) router.push(closeHref as Route, { scroll: false });
      }}
    >
      {children}
    </Drawer>
  );
}

// Actions ------------------------------------------------------------------------------------------

/**
 * One button that runs a server action. With `reason`, a dialog asks why first (every lifecycle
 * move and decision carries a reason); with `confirm`, it asks to confirm an irreversible act.
 * The outcome, refusals included, shows beside the button.
 */
export function ActionButton({
  action,
  hidden,
  label,
  variant = "secondary",
  reason,
  confirm,
  refusals,
  extraFields,
}: {
  action: ServerAction;
  hidden: Readonly<Record<string, string>>;
  label: string;
  variant?: ButtonProps["variant"];
  /** Dialog title when a reason is required. */
  reason?: string;
  /** Dialog title and sentence when the act needs confirming. */
  confirm?: { title: string; body: string };
  refusals: string;
  /** Extra fields shown in the dialog, for example a validity date. */
  extraFields?: FieldSpec[];
}) {
  const t = useCopy("procurement.kit");
  const router = useRouter();
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const [open, setOpen] = useState(false);
  const done = useRef<ActionState | null>(null);
  useEffect(() => {
    if (state.ok && done.current !== state) {
      done.current = state;
      setOpen(false);
      router.refresh();
    }
  }, [state, router]);
  const formId = `action-${label.replace(/[^a-z0-9]+/gi, "-")}-${Object.values(hidden).join("-")}`;
  const needsDialog = Boolean(reason || confirm || extraFields?.length);
  const form = (
    <form
      id={formId}
      action={formAction}
      onSubmit={keepInputOnSubmit(formAction)}
      className="flex flex-col gap-12"
      noValidate
    >
      {hiddenInputs(hidden)}
      {confirm ? <p className="m-0">{confirm.body}</p> : null}
      {reason ? (
        <Textarea
          id={`${formId}-reason`}
          name="reason"
          label={t("reason")}
          help={t("reasonHelp")}
          width="100%"
          rows={2}
          required
          error={state.fieldErrors?.["reason"] ? t("validation.required") : ""}
        />
      ) : null}
      {(extraFields ?? []).map((f) =>
        f.kind === "select" ? (
          <Select
            key={f.name}
            id={`${formId}-${f.name}`}
            name={f.name}
            label={f.label}
            options={f.options}
            {...(f.defaultValue !== undefined ? { value: f.defaultValue } : {})}
          />
        ) : f.kind === "textarea" ||
          f.kind === "checkboxes" ||
          f.kind === "file-checksum" ? null : (
          <Input
            key={f.name}
            id={`${formId}-${f.name}`}
            name={f.name}
            type={INPUT_TYPE[f.kind] ?? "text"}
            label={f.label}
            width="100%"
            defaultValue={f.defaultValue ?? ""}
            {...(f.help ? { help: f.help } : {})}
            error={state.fieldErrors?.[f.name] ? t(`validation.${state.fieldErrors[f.name]}`) : ""}
          />
        ),
      )}
      <ActionFeedback state={state} refusals={refusals} />
    </form>
  );
  if (!needsDialog) {
    return (
      <div className="flex flex-col gap-4">
        <form action={formAction}>
          {hiddenInputs(hidden)}
          <Button type="submit" variant={variant} size="sm" loading={pending}>
            {label}
          </Button>
        </form>
        <ActionFeedback state={state} refusals={refusals} />
      </div>
    );
  }
  return (
    <>
      <Button type="button" variant={variant} size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open ? (
        <Dialog
          title={reason ?? confirm?.title ?? label}
          open
          onOpenChange={setOpen}
          actions={
            <>
              <Button type="button" onClick={() => setOpen(false)}>
                {t("cancel")}
              </Button>
              <Button type="submit" form={formId} variant="primary" loading={pending}>
                {label}
              </Button>
            </>
          }
        >
          {form}
        </Dialog>
      ) : null}
      {!open && (state.rule || state.error) ? (
        <ActionFeedback state={state} refusals={refusals} />
      ) : null}
    </>
  );
}

/** The lifecycle moves the database allows from the current state, each asking for a reason. */
export function TransitionButtons({
  action,
  org,
  id,
  expected,
  moves,
  refusals,
}: {
  action: ServerAction;
  org: string;
  id: string;
  expected: string;
  moves: { next: string; label: string; danger?: boolean }[];
  refusals: string;
}) {
  const t = useCopy("procurement.kit");
  if (moves.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-8" role="group" aria-label={t("moves")}>
      {moves.map((m) => (
        <ActionButton
          key={m.next}
          action={action}
          hidden={{ org, id, expected, next: m.next }}
          label={m.label}
          variant={m.danger ? "danger" : "secondary"}
          reason={t("reasonFor", { move: m.label })}
          refusals={refusals}
        />
      ))}
    </div>
  );
}
