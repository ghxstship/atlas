"use client";

import { Button, InlineAlert } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect } from "react";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL } from "./forms.shared";
import { type Action } from "./forms.types";

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
