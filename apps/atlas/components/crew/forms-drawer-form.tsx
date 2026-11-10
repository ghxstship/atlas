"use client";

import type { WorkflowSignal } from "@xos/data/product-workflows";
import { emitWorkflow } from "@xos/data/workflow-signal";
import { Button, Drawer, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState } from "react";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL } from "./forms.shared";
import { type Action, type FieldSpec } from "./forms.types";

function useCloseHref(keys: readonly string[]) {
  const pathname = usePathname();
  const search = useSearchParams();
  const q = new URLSearchParams(search.toString());
  for (const k of keys) q.delete(k);
  const s = q.toString();
  return (s ? `${pathname}?${s}` : pathname) as Route;
}

function Field({
  spec,
  error,
  dependentOptions,
}: {
  spec: FieldSpec;
  error?: string;
  dependentOptions?: ReadonlyArray<{ value: string; label: string }>;
}) {
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
          options={[...spec.options, ...(dependentOptions ?? [])]}
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
  /** Workflow funnel signal sent when the action succeeds (A146). */
  signal?: WorkflowSignal;
}) {
  const t = useTranslations("crew.form");
  const router = useRouter();
  const close = useCloseHref(props.openKeys ?? ["create", "edit"]);
  const [state, action, pending] = useActionState(props.action, INITIAL);
  const signaled = useRef(state);
  const { signal } = props;
  // Only the selects another field depends on are followed; every other field stays uncontrolled.
  const [chosen, setChosen] = useState<Readonly<Record<string, string>>>({});
  const followed = new Set(
    props.fields.flatMap((f) => (f.kind === "select" && f.dependsOn ? [f.dependsOn.field] : [])),
  );
  const valueOf = (name: string) =>
    chosen[name] ?? props.fields.find((f) => f.name === name)?.value ?? "";
  useEffect(() => {
    if (state.ok) {
      if (signal && signaled.current !== state) emitWorkflow(signal);
      signaled.current = state;
      router.push((state.redirect as Route | undefined) ?? close);
      router.refresh();
    }
  }, [state, close, router, signal]);
  return (
    <Drawer
      title={props.title}
      open
      onOpenChange={(open) => (open ? undefined : router.push(close))}
    >
      <form
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        onChange={(e) => {
          const control = e.target as EventTarget as HTMLSelectElement;
          if (followed.has(control.name)) {
            setChosen((before) => ({ ...before, [control.name]: control.value }));
          }
        }}
        className="flex flex-col gap-16"
        noValidate
      >
        {state.error ? (
          <InlineAlert tone="danger" title={t("refused")}>
            {state.error}
          </InlineAlert>
        ) : null}
        {props.fields.map((f) => {
          const on = f.kind === "select" ? f.dependsOn : undefined;
          return (
            <Field
              key={on ? `${f.name}:${valueOf(on.field)}` : f.name}
              spec={f}
              {...(on ? { dependentOptions: on.optionsBy[valueOf(on.field)] ?? [] } : {})}
              {...(state.fieldErrors?.[f.name] ? { error: state.fieldErrors[f.name] } : {})}
            />
          );
        })}
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
