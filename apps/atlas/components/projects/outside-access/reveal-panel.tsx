"use client";

import { Button, Input } from "@xos/ui";
import { useTranslations } from "next-intl";
import { lazy, Suspense, useId, useState } from "react";
import type { Revealed } from "@/lib/outside-access/actions";

/** The QR code loads only when there is a link to draw. */
const QrCode = lazy(() => import("@/components/handoff/handoff-code"));

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  const t = useTranslations("projects.outsideAccess.reveal");
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-end gap-8">
      <Input id={id} label={label} value={value} readOnly width="100%" />
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? t("copied") : t("copy")}
      </Button>
    </div>
  );
}

/**
 * The one-time reveal (B2, ADR 0141): a new link, code and QR code. It lives in client state above the list, never in
 * a row a refresh replaces, and stays through router.refresh until dismissed. A hashed token cannot be redrawn later.
 */
export function RevealPanel({ revealed, onDismiss }: { revealed: Revealed; onDismiss: () => void }) {
  const t = useTranslations("projects.outsideAccess.reveal") as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const id = useId();
  return (
    <div
      className="flex flex-col gap-8 rounded-lg border border-border-subtle bg-bg-surface p-16"
      role="status"
      data-outside-reveal=""
    >
      <h3 className="m-0 text-label-13 font-medium">{t(`headings.${revealed.heading}`)}</h3>
      <p className="m-0 text-text-12 text-text-secondary">
        {revealed.name ? t("codeOnce", { name: revealed.name }) : t("once")}
      </p>
      {revealed.url ? <CopyField id={`${id}-url`} label={t("link")} value={revealed.url} /> : null}
      {revealed.accessCode ? (
        <CopyField id={`${id}-code`} label={t("code")} value={revealed.accessCode} />
      ) : null}
      {revealed.url ? (
        <Suspense fallback={null}>
          <QrCode url={revealed.url} label={t("qr")} />
        </Suspense>
      ) : null}
      <div>
        <Button type="button" size="sm" variant="secondary" onClick={onDismiss}>
          {t("dismiss")}
        </Button>
      </div>
    </div>
  );
}
