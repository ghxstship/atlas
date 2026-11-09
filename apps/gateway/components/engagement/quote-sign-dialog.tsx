"use client";

import { Button, Dialog, InlineAlert } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";
import { signDocumentAction } from "@/lib/actions/engagement";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The confirmation behind Sign on a Quote row (S14.5-01), loaded when it opens. */
export function QuoteSignDialog({
  documentId,
  total,
  validUntil,
  setOpen,
}: {
  documentId: string;
  total: string;
  validUntil: string;
  setOpen: (open: boolean) => void;
}) {
  const t = useTranslations("gateway.engagement.documents.quote") as unknown as Translate;
  const common = useTranslations("gateway.common") as unknown as Translate;
  const outcomes = useTranslations("gateway.outcomes") as unknown as Translate;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(next) => setOpen(next)}
      title={t("confirmTitle")}
      description={t("consent")}
      actions={
        <>
          <Button onClick={() => setOpen(false)}>{common("cancel")}</Button>
          <Button
            variant="primary"
            icon="FileSignature"
            disabled={pending}
            aria-busy={pending}
            onClick={() =>
              start(async () => {
                const next = await signDocumentAction(documentId);
                setResult(next);
                if (next.ok) {
                  setOpen(false);
                  router.refresh();
                }
              })
            }
          >
            {t("accept")}
          </Button>
        </>
      }
    >
      <dl className="m-0 flex flex-col gap-4 text-text-13">
        <div className="flex justify-between gap-12">
          <dt className="text-text-secondary">{t("total")}</dt>
          <dd className="m-0 tabular-nums">{total}</dd>
        </div>
        <div className="flex justify-between gap-12">
          <dt className="text-text-secondary">{t("validUntil")}</dt>
          <dd className="m-0">{validUntil}</dd>
        </div>
      </dl>
      {result && !result.ok ? (
        <InlineAlert tone="danger">{outcomes(result.outcome)}</InlineAlert>
      ) : null}
    </Dialog>
  );
}
