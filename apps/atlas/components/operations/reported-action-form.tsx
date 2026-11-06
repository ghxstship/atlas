"use client";

import { useTranslations } from "next-intl";
import type { ComponentProps } from "react";
import { ActionForm, messageValues, type FormAction } from "./action-form";
import { useReportResult } from "./result-region";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** An ActionForm whose success sentence shows in the ResultRegion above it, because the form itself may leave. */
export function ReportedActionForm({
  action,
  successKey,
  ...props
}: Omit<ComponentProps<typeof ActionForm>, "successKey"> & { successKey: string }) {
  const report = useReportResult();
  const t = useTranslations() as unknown as Translate;
  const reported: FormAction = async (state, form) => {
    const next = await action(state, form);
    if (next.ok) report(t(successKey, messageValues(next.result)));
    return next;
  };
  return <ActionForm action={reported} {...props} />;
}
