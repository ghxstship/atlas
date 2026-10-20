"use client";

import { ACCOUNT_SUPPORT_CATEGORIES, type AccountSupportCategory } from "@xos/data/support";
import { Button, buttonClass, Checkbox, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import {
  openAccountSupportRequestAction,
  uploadAccountSupportScreenshotAction,
  type SupportError,
} from "@/lib/actions/support";
import { recentErrors } from "@/lib/recent-errors";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Contact Support in Gateway (Section 11.16). Work questions go to the organization that engaged the
 * person, in Messages: the engagement's own Messages tab when Help opened on an engagement, else
 * Messages. Platform support takes requests about the person's own account only, answers by email,
 * and gets diagnostics only when the person ticks the box, after seeing exactly what is sent.
 */
export function ContactSupport({
  engagementKey,
  pathname,
  onBack,
  onNavigate,
}: {
  readonly engagementKey: string | null;
  readonly pathname: string;
  readonly onBack: () => void;
  readonly onNavigate: () => void;
}) {
  const t = useTranslations("help") as unknown as Translate;
  const id = useId();
  const [category, setCategory] = useState<AccountSupportCategory>("Account");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [consent, setConsent] = useState(false);
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [shotTooBig, setShotTooBig] = useState(false);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SupportError | null>(null);
  const [sent, setSent] = useState<{ number: string; email: string } | null>(null);
  const [diagnostics] = useState(() => ({
    route: pathname.slice(0, 500),
    appVersion: process.env.NEXT_PUBLIC_XOS_RELEASE?.slice(0, 50) || null,
    device: navigator.userAgent.slice(0, 300),
    recentErrors: recentErrors(),
  }));

  const messagesHref = engagementKey ? `/work/engagements/${engagementKey}/messages` : "/messages";

  return (
    <div className="flex flex-col gap-16">
      <Button variant="ghost" icon="ArrowLeft" onClick={onBack} className="self-start">
        {t("back")}
      </Button>
      <h3 className="m-0 text-heading-20 font-semibold">{t("contact.title")}</h3>

      <section aria-labelledby={`${id}-work`} className="flex flex-col gap-8">
        <h4 id={`${id}-work`} className="m-0 text-heading-16 font-semibold">
          {t("gateway.contact.workTitle")}
        </h4>
        <p className="m-0 text-text-13 text-text-secondary">{t("gateway.contact.workBody")}</p>
        <NextLink
          href={messagesHref as Route}
          onClick={onNavigate}
          className={`${buttonClass("secondary", "md")} self-start`}
        >
          {t(engagementKey ? "gateway.contact.messageOrg" : "gateway.contact.openMessages")}
        </NextLink>
      </section>

      <section aria-labelledby={`${id}-account`} className="flex flex-col gap-12">
        <h4 id={`${id}-account`} className="m-0 text-heading-16 font-semibold">
          {t("gateway.contact.accountTitle")}
        </h4>
        <p className="m-0 text-text-13 text-text-secondary">{t("gateway.contact.accountBody")}</p>
        {sent ? (
          <InlineAlert tone="success">{t("gateway.contact.sent", sent)}</InlineAlert>
        ) : (
          <form
            aria-labelledby={`${id}-account`}
            className="flex flex-col gap-12"
            onSubmit={async (e) => {
              e.preventDefault();
              if (subject.trim() === "" || body.trim() === "") {
                setMissing(true);
                return;
              }
              setBusy(true);
              setError(null);
              // The screenshot goes up first, to the person's own folder, and only with consent.
              let screenshotPath: string | null = null;
              if (consent && screenshot) {
                const form = new FormData();
                form.set("screenshot", screenshot);
                const uploaded = await uploadAccountSupportScreenshotAction(form);
                if (!uploaded.ok) {
                  setBusy(false);
                  setError(uploaded.error);
                  return;
                }
                screenshotPath = uploaded.data.path;
              }
              const result = await openAccountSupportRequestAction({
                category,
                subject,
                body,
                diagnostics: consent ? { ...diagnostics, screenshotPath } : null,
              });
              setBusy(false);
              if (result.ok) setSent(result.data);
              else setError(result.error);
            }}
          >
            <Select
              id={`${id}-category`}
              label={t("contact.category")}
              value={category}
              options={ACCOUNT_SUPPORT_CATEGORIES.map((c) => ({
                value: c,
                label: t(`gateway.contact.categories.${c}`),
              }))}
              onChange={(e) => setCategory(e.target.value as AccountSupportCategory)}
            />
            <Input
              label={t("contact.subject")}
              value={subject}
              maxLength={200}
              placeholder={t("gateway.contact.subjectHint")}
              width="100%"
              {...(missing && subject.trim() === ""
                ? { error: t("gateway.contact.required") }
                : {})}
              onChange={(e) => setSubject(e.target.value)}
            />
            <Textarea
              label={t("gateway.contact.body")}
              value={body}
              maxLength={10000}
              rows={5}
              placeholder={t("gateway.contact.bodyHint")}
              width="100%"
              {...(missing && body.trim() === "" ? { error: t("gateway.contact.required") } : {})}
              onChange={(e) => setBody(e.target.value)}
            />
            <Checkbox
              label={t("contact.diagnostics")}
              checked={consent}
              aria-describedby={`${id}-diagnostics`}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <div
              id={`${id}-diagnostics`}
              className="flex flex-col gap-4 text-text-12 text-text-secondary"
            >
              <p className="m-0">{t("contact.diagnosticsHelp")}</p>
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-8 gap-y-2">
                <dt>{t("contact.diagnosticsRoute")}</dt>
                <dd className="m-0 break-all font-mono">{diagnostics.route}</dd>
                {diagnostics.appVersion ? (
                  <>
                    <dt>{t("contact.diagnosticsVersion")}</dt>
                    <dd className="m-0 font-mono">{diagnostics.appVersion}</dd>
                  </>
                ) : null}
                <dt>{t("contact.diagnosticsDevice")}</dt>
                <dd className="m-0 break-all">{diagnostics.device}</dd>
                <dt>{t("contact.diagnosticsErrors")}</dt>
                <dd className="m-0 whitespace-pre-wrap break-all font-mono">
                  {diagnostics.recentErrors ?? t("contact.diagnosticsNoErrors")}
                </dd>
              </dl>
            </div>
            <div className="flex flex-col gap-4">
              <label htmlFor={`${id}-screenshot`} className="text-text-13 font-medium">
                {t("contact.screenshot")}
              </label>
              <input
                id={`${id}-screenshot`}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={!consent}
                aria-describedby={`${id}-screenshot-help`}
                className="text-text-13"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  const tooBig = file !== null && file.size > SCREENSHOT_MAX_BYTES;
                  setShotTooBig(tooBig);
                  setScreenshot(tooBig ? null : file);
                }}
              />
              <p id={`${id}-screenshot-help`} className="m-0 text-text-12 text-text-secondary">
                {consent ? t("contact.screenshotHelp") : t("contact.screenshotNeedsConsent")}
              </p>
              {shotTooBig ? (
                <p role="alert" className="m-0 text-text-12 text-danger-text">
                  {t("contact.screenshotTooBig")}
                </p>
              ) : null}
            </div>
            {error ? (
              <p role="alert" className="m-0 text-text-12 text-danger-text">
                {t(`gateway.contact.errors.${error}`)}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-8">
              <Button variant="primary" type="submit" loading={busy}>
                {t("contact.send")}
              </Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
