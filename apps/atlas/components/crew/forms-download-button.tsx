"use client";

import { Button, InlineAlert } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import type { CrewActionState } from "@/lib/crew/action-state";
import { useStepUpForm } from "@/components/auth/security/step-up";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL } from "./forms.shared";
import { type Action } from "./forms.types";

const stepUpRefused = (state: CrewActionState) => state.rule === "step_up_required";

/**
 * Downloads a file an action returned (the payroll export), as the browser's own save. A payroll export is a
 * Restricted export: when the database asks for step-up, the step-up dialog gets a second factor and retries.
 */
export function DownloadButton(props: {
  label: string;
  action: Action;
  hidden: Readonly<Record<string, string>>;
}) {
  const t = useTranslations("crew.form");
  const router = useRouter();
  const [state, action, pending] = useActionState(props.action, INITIAL);
  const form = useRef<HTMLFormElement>(null);
  const stepUpDialog = useStepUpForm(state, stepUpRefused, form);
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
  // The dialog renders outside the form: React bubbles a portal's submit event to its tree parents.
  return (
    <>
      {stepUpDialog}
      <form
        ref={form}
        action={action}
        onSubmit={keepInputOnSubmit(action)}
        className="flex flex-col gap-8"
      >
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
    </>
  );
}
