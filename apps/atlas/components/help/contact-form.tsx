"use client";

import {
  SUPPORT_CATEGORIES,
  SUPPORT_SEVERITIES,
  type SupportChannel,
  type SupportQueue,
} from "@xos/data/support";
import { Button, Checkbox, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { openSupportRequestAction, type HelpActionError } from "@/lib/help/actions";
import type { CollectedDiagnostics } from "./diagnostics";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Contact support (Section 11.16): a request to the org's admins, or, for holders of org.help.write
 * on a plan with a platform channel, to the platform team. Diagnostics are listed in full and sent
 * only when the consent box is ticked.
 */
export function ContactForm({
  org,
  canContactPlatform,
  platformChannel,
  diagnostics,
  onCancel,
  initialQueue = "Organization",
}: {
  org: string;
  canContactPlatform: boolean;
  platformChannel: SupportChannel | null;
  diagnostics: CollectedDiagnostics;
  onCancel: () => void;
  initialQueue?: SupportQueue;
}) {
  const t = useTranslations("help.contact") as unknown as Translate;
  const s = useTranslations("support") as unknown as Translate;
  const id = useId();
  const [queue, setQueue] = useState<SupportQueue>(initialQueue);
  const [category, setCategory] = useState<string>("Problem");
  const [severity, setSeverity] = useState<string>("Severity 3");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<HelpActionError | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const platform = canContactPlatform && platformChannel !== null;

  if (sent !== null) {
    return (
      <div className="flex flex-col gap-12">
        <InlineAlert tone="success">{t("sent", { number: sent })}</InlineAlert>
        <Link
          href={`/${org}/me/account` as Route}
          className="font-medium text-accent-text underline"
        >
          {t("followUp")}
        </Link>
      </div>
    );
  }

  return (
    <form
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-12"
      onSubmit={async (e) => {
        e.preventDefault();
        if (subject.trim() === "" || body.trim() === "") {
          setMissing(true);
          return;
        }
        setBusy(true);
        setError(null);
        const result = await openSupportRequestAction(org, {
          queue,
          category,
          severity: queue === "Platform" ? severity : "Severity 3",
          subject,
          body,
          diagnostics: consent
            ? {
                route: diagnostics.route,
                appVersion: diagnostics.appVersion,
                device: diagnostics.device,
                recentErrors: diagnostics.recentErrors,
              }
            : null,
        });
        setBusy(false);
        if (result.ok) setSent(result.data.number ?? "");
        else setError(result.error);
      }}
    >
      <h3 id={`${id}-title`} className="m-0 text-heading-16 font-semibold">
        {t("title")}
      </h3>
      <p className="m-0 text-text-secondary">{t("description")}</p>
      {canContactPlatform ? (
        <Select
          id={`${id}-queue`}
          label={t("queue")}
          value={queue}
          options={[
            { value: "Organization", label: t("queues.Organization") },
            ...(platform ? [{ value: "Platform", label: t("queues.Platform") }] : []),
          ]}
          {...(platformChannel
            ? { help: t("platformTerms", { terms: s(`channels.${platformChannel}`) }) }
            : { help: s("org.noPlatform") })}
          onChange={(e) => setQueue(e.target.value as SupportQueue)}
        />
      ) : null}
      <Select
        id={`${id}-category`}
        label={t("category")}
        value={category}
        options={SUPPORT_CATEGORIES.map((c) => ({ value: c, label: s(`categories.${c}`) }))}
        onChange={(e) => setCategory(e.target.value)}
      />
      {queue === "Platform" ? (
        <Select
          id={`${id}-severity`}
          label={t("severity")}
          value={severity}
          options={SUPPORT_SEVERITIES.map((v) => ({ value: v, label: s(`severities.${v}`) }))}
          onChange={(e) => setSeverity(e.target.value)}
        />
      ) : null}
      <Input
        label={t("subject")}
        value={subject}
        maxLength={200}
        placeholder={t("subjectHint")}
        width="100%"
        {...(missing && subject.trim() === "" ? { error: t("required") } : {})}
        onChange={(e) => setSubject(e.target.value)}
      />
      <Textarea
        label={t("body")}
        value={body}
        maxLength={10000}
        rows={5}
        placeholder={t("bodyHint")}
        width="100%"
        {...(missing && body.trim() === "" ? { error: t("required") } : {})}
        onChange={(e) => setBody(e.target.value)}
      />
      <Checkbox
        label={t("diagnostics")}
        checked={consent}
        aria-describedby={`${id}-diagnostics`}
        onChange={(e) => setConsent(e.target.checked)}
      />
      <div
        id={`${id}-diagnostics`}
        className="flex flex-col gap-4 text-text-12 text-text-secondary"
      >
        <p className="m-0">{t("diagnosticsHelp")}</p>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-8 gap-y-2">
          <dt>{t("diagnosticsRoute")}</dt>
          <dd className="m-0 break-all font-mono">{diagnostics.route}</dd>
          {diagnostics.appVersion ? (
            <>
              <dt>{t("diagnosticsVersion")}</dt>
              <dd className="m-0 font-mono">{diagnostics.appVersion}</dd>
            </>
          ) : null}
          <dt>{t("diagnosticsDevice")}</dt>
          <dd className="m-0 break-all">{diagnostics.device}</dd>
          <dt>{t("diagnosticsErrors")}</dt>
          <dd className="m-0 whitespace-pre-wrap break-all font-mono">
            {diagnostics.recentErrors ?? t("diagnosticsNoErrors")}
          </dd>
        </dl>
      </div>
      {error ? (
        <p role="alert" className="m-0 text-text-12 text-danger-text">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-8">
        <Button onClick={onCancel}>{t("cancel")}</Button>
        <Button variant="primary" type="submit" loading={busy}>
          {t("send")}
        </Button>
      </div>
    </form>
  );
}
