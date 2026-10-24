"use client";

import { FeedbackWidget, InlineAlert } from "@xos/ui";
import { useLocale, useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useId, useState } from "react";
import { uploadSupportScreenshotAction } from "@/lib/help/actions";
import { sendFeedbackAction } from "@/lib/help/first-run-actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const MAX_SCREENSHOT = 5 * 1024 * 1024;

/**
 * Send Feedback in the help panel (Section 11.7, A96): the design system's FeedbackWidget with a screenshot the person
 * chooses, uploaded through the support screenshot path (1034), and, shown before sending, the page context that goes
 * with the message. Nothing else is captured.
 */
export function FeedbackForm({ org, onCancel }: { org: string; onCancel: () => void }) {
  const t = useTranslations("firstRun.feedback") as unknown as Translate;
  const locale = useLocale();
  const pathname = usePathname();
  const id = useId();
  const [file, setFile] = useState<File | null>(null);
  const [tooBig, setTooBig] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [thanks, setThanks] = useState<string | undefined>(undefined);
  const viewport =
    typeof window === "undefined" ? null : `${window.innerWidth}x${window.innerHeight}`;
  const version = process.env["NEXT_PUBLIC_APP_VERSION"] ?? null;

  const send = async ({ text }: { text: string }): Promise<boolean> => {
    setProblem(null);
    let screenshotPath: string | null = null;
    if (file) {
      const form = new FormData();
      form.set("screenshot", file);
      const uploaded = await uploadSupportScreenshotAction(org, form);
      if (!uploaded.ok) {
        setProblem(t("failedUpload"));
        return false;
      }
      screenshotPath = uploaded.data.path;
    }
    const result = await sendFeedbackAction(org, {
      message: text,
      route: pathname,
      appVersion: version,
      locale,
      viewport,
      screenshotPath,
    });
    if (result.ok) {
      setThanks(t("thanks", { number: result.number }));
      return true;
    }
    if (result.error === "limit") setProblem(t("limit"));
    return false;
  };

  const screenshotField = (
    <div className="flex flex-col gap-4">
      <label htmlFor={`${id}-shot`} className="text-text-13 font-medium">
        {t("screenshot")}
      </label>
      <input
        id={`${id}-shot`}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        aria-describedby={`${id}-shot-help`}
        className="text-text-13"
        onChange={(e) => {
          const chosen = e.target.files?.[0] ?? null;
          const big = chosen !== null && chosen.size > MAX_SCREENSHOT;
          setTooBig(big);
          setFile(big ? null : chosen);
        }}
      />
      <p
        id={`${id}-shot-help`}
        className={`m-0 text-text-12 ${tooBig ? "text-danger-text" : "text-text-secondary"}`}
      >
        {t("screenshotHint")}
      </p>
    </div>
  );

  return (
    <div className="flex flex-col gap-8" data-testid="feedback-form">
      <FeedbackWidget
        onSend={send}
        onCancel={onCancel}
        screenshotField={screenshotField}
        context={t("context", {
          route: pathname,
          app: "Atlas",
          version: version ?? t("unknownVersion"),
          locale,
          viewport: viewport ?? "",
        })}
        {...(thanks === undefined ? {} : { thanks })}
      />
      {problem ? <InlineAlert tone="danger">{problem}</InlineAlert> : null}
    </div>
  );
}
