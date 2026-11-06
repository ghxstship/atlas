"use client";

import { Button, Input } from "@xos/ui";
import { useTranslations } from "next-intl";
import { lazy, Suspense, useCallback, useId, useRef, useState } from "react";
import type { Revealed } from "@/lib/outside-access/actions";

/** The QR code loads only when there is a link to draw. */
const QrCode = lazy(() => import("@/components/handoff/handoff-code"));

export interface HeldReveal {
  readonly key: number;
  readonly revealed: Revealed;
}

/**
 * The one-time values a screen holds until each is dismissed. A list, because a code is stored only as a hash: adding
 * two recipients in a row must never lose the first code to the second.
 */
export function useReveals() {
  const next = useRef(0);
  const [reveals, setReveals] = useState<readonly HeldReveal[]>([]);
  const add = useCallback((revealed: Revealed) => {
    next.current += 1;
    const key = next.current;
    setReveals((held) => [{ key, revealed }, ...held]);
  }, []);
  const dismiss = useCallback((key: number) => {
    setReveals((held) => held.filter((r) => r.key !== key));
  }, []);
  return { reveals, add, dismiss };
}

function CopyButton({ value, label }: { value: string; label?: string }) {
  const t = useTranslations("projects.outsideAccess.reveal");
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => setCopied(true));
      }}
    >
      {copied ? t("copied") : t("copy")}
    </Button>
  );
}

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className="flex items-end gap-8">
      <Input id={id} label={label} value={value} readOnly width="100%" />
      <CopyButton value={value} />
    </div>
  );
}

/**
 * The one-time reveal (B2, ADR 0141): a new link, code and QR code. It lives in client state above the list, never in
 * a row a refresh replaces, and stays through router.refresh until dismissed. A hashed token cannot be redrawn later.
 */
export function RevealPanel({
  revealed,
  onDismiss,
}: {
  revealed: Revealed;
  onDismiss: () => void;
}) {
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

/** Every value a screen holds, newest first, each until it is dismissed. */
export function RevealPanels({
  reveals,
  onDismiss,
}: {
  reveals: readonly HeldReveal[];
  onDismiss: (key: number) => void;
}) {
  return (
    <>
      {reveals.map((r) => (
        <RevealPanel key={r.key} revealed={r.revealed} onDismiss={() => onDismiss(r.key)} />
      ))}
    </>
  );
}

/**
 * The same codes inside an open dialog, where they must be readable at once rather than behind it. Plain text, not
 * fields: gate 27 counts every field in a dialog, and adding eight recipients would otherwise pass seven.
 */
export function RevealLines({
  reveals,
  onDismiss,
}: {
  reveals: readonly HeldReveal[];
  onDismiss: (key: number) => void;
}) {
  const t = useTranslations("projects.outsideAccess.reveal") as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const codes = reveals.filter((r) => r.revealed.accessCode !== null);
  if (codes.length === 0) return null;
  return (
    <ul
      className="m-0 flex list-none flex-col gap-8 rounded-lg border border-border-subtle bg-bg-surface p-16"
      role="status"
    >
      {codes.map(({ key, revealed }) => (
        <li key={key} className="flex flex-col gap-4" data-outside-reveal-line="">
          <span className="text-text-12 text-text-secondary">
            {revealed.name ? t("codeOnce", { name: revealed.name }) : t("once")}
          </span>
          <span className="flex flex-wrap items-center gap-8">
            <code className="text-label-13 font-medium" data-outside-reveal-code="">
              {revealed.accessCode}
            </code>
            <CopyButton value={revealed.accessCode ?? ""} />
            <Button type="button" size="sm" variant="ghost" onClick={() => onDismiss(key)}>
              {t("dismiss")}
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}
