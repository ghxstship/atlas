"use client";

import { RefusalNotice as UiRefusalNotice, type RefusalNoticeProps } from "@xos/ui";
import { useTranslations } from "next-intl";

/**
 * The design system's refusal notice with its outcome in words ("Refused", "No answer", "Not
 * ratified") instead of the bare outcome code (Section 11.10 item 2, A59-017). Atlas renders every
 * refusal notice through this one.
 */
export function RefusalNotice(props: RefusalNoticeProps) {
  const t = useTranslations("shell.refusalOutcome");
  return <UiRefusalNotice outcomeLabel={t(props.outcome)} {...props} />;
}
