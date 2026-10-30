"use client";

import { Button, InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useRef, type ReactNode } from "react";
import type { CrewActionState } from "@/lib/crew/action-state";
import type { Action } from "./forms.types";

const INITIAL: CrewActionState = {};

/**
 * A crew form set in a page rather than a drawer (A132: shift templates in Settings, availability in Me): the
 * controls come from the server as children, the server action answers with translated sentences, and a refusal
 * keeps what was typed and lists what to fix. Success rereads the page and announces `successMessage`.
 */
export function CrewInlineForm(props: {
  action: Action;
  hidden: Readonly<Record<string, string>>;
  submitLabel: string;
  successMessage?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  layout?: "stack" | "inline";
  resetOnSuccess?: boolean;
  label?: string;
  children?: ReactNode;
}) {
  const t = useTranslations("crew.form");
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [state, run, pending] = useActionState(props.action, INITIAL);

  useEffect(() => {
    if (!state.ok) return;
    if (props.resetOnSuccess) form.current?.reset();
    router.refresh();
  }, [state, props.resetOnSuccess, router]);

  const fieldErrors = Object.values(state.fieldErrors ?? {});
  return (
    <form
      ref={form}
      {...(props.label ? { "aria-label": props.label } : {})}
      onSubmit={(event) => {
        // A transition rather than the form action keeps the typed input when the action is refused.
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => run(data));
      }}
      noValidate
      className={
        props.layout === "inline" ? "flex flex-wrap items-end gap-8" : "flex flex-col gap-12"
      }
    >
      {Object.entries(props.hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {state.error ? (
        <div className="basis-full">
          <InlineAlert tone="danger" title={t("refused")}>
            {state.error}
            {fieldErrors.length > 0 ? (
              <ul className="m-0 mt-4 ps-16">
                {fieldErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : null}
          </InlineAlert>
        </div>
      ) : null}
      {props.children}
      <div className="flex flex-wrap items-center gap-12">
        <Button type="submit" variant={props.variant ?? "primary"} size="sm" loading={pending}>
          {props.submitLabel}
        </Button>
        <p role="status" className="m-0 text-text-13 text-success-text">
          {state.ok && props.successMessage ? props.successMessage : null}
        </p>
      </div>
    </form>
  );
}
