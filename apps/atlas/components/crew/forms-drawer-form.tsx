"use client";

import { Button, Drawer, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect } from "react";
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
