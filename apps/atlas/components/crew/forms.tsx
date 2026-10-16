"use client";

import { Button, Dialog, Drawer, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState } from "react";
import type { CrewActionState } from "@/lib/crew/action-state";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
/**
 * The form kit for People and Crew: a field-spec form inside a Drawer for create and edit
 * (`?create=1`, `?edit=<id>`), and a confirm button that asks for the reason every state change
 * carries (Section 3.12). Server actions decide every write; a refusal shows its rule in words and the
 * typed input stays in place.
 */

export type FieldSpec =
  | {
      readonly kind: "text" | "date" | "datetime" | "number" | "money";
      readonly name: string;
      readonly label: string;
      readonly value?: string;
      readonly required?: boolean;
      readonly help?: string;
      readonly step?: string;
      readonly min?: string;
    }
  | {
      readonly kind: "textarea";
      readonly name: string;
      readonly label: string;
      readonly value?: string;
      readonly required?: boolean;
      readonly help?: string;
    }
  | {
      readonly kind: "select";
      readonly name: string;
      readonly label: string;
      readonly value?: string;
      readonly options: ReadonlyArray<{ value: string; label: string }>;
      readonly help?: string;
    }
  | { readonly kind: "hidden"; readonly name: string; readonly value: string };

type Action = (state: CrewActionState, form: FormData) => Promise<CrewActionState>;

const INITIAL: CrewActionState = {};

function useCloseHref(keys: readonly string[]) {
  const pathname = usePathname();
  const search = useSearchParams();
  const q = new URLSearchParams(search.toString());
  for (const k of keys) q.delete(k);
  const s = q.toString();
  return (s ? `${pathname}?${s}` : pathname) as Route;
}

function Field({ spec, error }: { spec: FieldSpec; error?: string }) {
  const id = `crew-field-${spec.name}`;
  switch (spec.kind) {
    case "hidden":
      return <input type="hidden" name={spec.name} value={spec.value} />;
    case "select":
      return (
        <Select
          id={id}
          name={spec.name}
          label={spec.label}
          value={spec.value ?? ""}
          options={[...spec.options]}
          {...(spec.help ? { help: spec.help } : {})}
          {...(error ? { error } : {})}
        />
      );
    case "textarea":
      return (
        <Textarea
          id={id}
          name={spec.name}
          label={spec.label}
          defaultValue={spec.value ?? ""}
          required={spec.required}
          width="100%"
          {...(spec.help ? { help: spec.help } : {})}
          {...(error ? { error } : {})}
        />
      );
    default: {
      const type =
        spec.kind === "datetime" ? "datetime-local" : spec.kind === "money" ? "number" : spec.kind;
      return (
        <Input
          id={id}
          name={spec.name}
          type={type}
          label={spec.label}
          defaultValue={spec.value ?? ""}
          required={spec.required}
          width="100%"
          {...(spec.kind === "money"
            ? { step: "0.01", min: "0", inputMode: "decimal" as const }
            : {})}
          {...(spec.step ? { step: spec.step } : {})}
          {...(spec.min ? { min: spec.min } : {})}
          {...(spec.help ? { help: spec.help } : {})}
          {...(error ? { error } : {})}
        />
      );
    }
  }
}

/** A create or edit form in a Drawer; closing or saving returns to the list with its filters. */
export function DrawerForm(props: {
  title: string;
  submitLabel: string;
  action: Action;
  fields: readonly FieldSpec[];
  /** Query keys that open this drawer and are removed when it closes. */
  openKeys?: readonly string[];
}) {
  const t = useTranslations("crew.form");
  const router = useRouter();
  const close = useCloseHref(props.openKeys ?? ["create", "edit"]);
  const [state, action, pending] = useActionState(props.action, INITIAL);
  useEffect(() => {
    if (state.ok) {
      router.push((state.redirect as Route | undefined) ?? close);
      router.refresh();
    }
  }, [state, close, router]);
  return (
    <Drawer
      title={props.title}
      open
      onOpenChange={(open) => (open ? undefined : router.push(close))}
    >
      <form
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        className="flex flex-col gap-16"
        noValidate
      >
        {state.error ? (
          <InlineAlert tone="danger" title={t("refused")}>
            {state.error}
          </InlineAlert>
        ) : null}
        {props.fields.map((f) => (
          <Field
            key={f.name}
            spec={f}
            {...(state.fieldErrors?.[f.name] ? { error: state.fieldErrors[f.name] } : {})}
          />
        ))}
        <div className="flex gap-8">
          <Button type="submit" variant="primary" loading={pending}>
            {props.submitLabel}
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.push(close)}>
            {t("cancel")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/**
 * A button for a state change or another irreversible act: it opens a dialog asking for the reason
 * (prefilled with a sentence the person can edit) and submits the action with its hidden fields.
 */
export function ConfirmButton(props: {
  label: string;
  title: string;
  description?: string;
  defaultReason: string;
  action: Action;
  hidden: Readonly<Record<string, string>>;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  /** Ask for a reason; acts without one say only what will happen. */
  reason?: boolean;
  confirmLabel?: string;
}) {
  const t = useTranslations("crew.form");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(async (prev: CrewActionState, form: FormData) => {
    const next = await props.action(prev, form);
    if (next.ok) {
      setOpen(false);
      router.refresh();
    }
    return next;
  }, INITIAL);
  const formId = `confirm-${props.label.replace(/\W+/g, "-")}-${Object.values(props.hidden).join("-")}`;
  return (
    <>
      <Button
        type="button"
        variant={props.variant ?? "secondary"}
        size="sm"
        onClick={() => setOpen(true)}
      >
        {props.label}
      </Button>
      {open ? (
        <Dialog
          title={props.title}
          open
          onOpenChange={setOpen}
          {...(props.description ? { description: props.description } : {})}
          actions={
            <>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {t("cancel")}
              </Button>
              <Button
                type="submit"
                form={formId}
                variant={props.variant === "danger" ? "danger" : "primary"}
                loading={pending}
              >
                {props.confirmLabel ?? props.label}
              </Button>
            </>
          }
        >
          <form
            id={formId}
            action={action}
            onSubmit={keepInputOnSubmit(action)}
            className="flex flex-col gap-12"
            noValidate
          >
            {Object.entries(props.hidden).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            {state.error ? (
              <InlineAlert tone="danger" title={t("refused")}>
                {state.error}
              </InlineAlert>
            ) : null}
            {props.reason === false ? (
              <input type="hidden" name="reason" value={props.defaultReason} />
            ) : (
              <Textarea
                id={`${formId}-reason`}
                name="reason"
                label={t("reason")}
                help={t("reasonHelp")}
                defaultValue={props.defaultReason}
                required
                width="100%"
              />
            )}
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

/** Downloads a file an action returned (the payroll export), as the browser's own save. */
export function DownloadButton(props: {
  label: string;
  action: Action;
  hidden: Readonly<Record<string, string>>;
}) {
  const t = useTranslations("crew.form");
  const router = useRouter();
  const [state, action, pending] = useActionState(props.action, INITIAL);
  useEffect(() => {
    if (state.ok) router.refresh();
    if (!state.file) return;
    const blob = new Blob([state.file.content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = state.file.name;
    a.click();
    URL.revokeObjectURL(url);
  }, [state, router]);
  return (
    <form action={action} onSubmit={keepInputOnSubmit(action)} className="flex flex-col gap-8">
      {Object.entries(props.hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <div>
        <Button type="submit" size="sm" variant="secondary" icon="Download" loading={pending}>
          {props.label}
        </Button>
      </div>
      {state.error ? (
        <InlineAlert tone="danger" title={t("refused")}>
          {state.error}
        </InlineAlert>
      ) : null}
    </form>
  );
}
