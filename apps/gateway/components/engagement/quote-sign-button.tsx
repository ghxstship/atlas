"use client";

import { Button } from "@xos/ui";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useState } from "react";

const QuoteSignDialog = dynamic(() => import("./quote-sign-dialog").then((m) => m.QuoteSignDialog));

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Sign on a Quote row (S14.5-01): a confirmation with the total, the valid-until date and the consent
 * sentence, because a quote is a commercial commitment and is never signed in one click.
 */
export function QuoteSignButton({
  documentId,
  total,
  validUntil,
}: {
  documentId: string;
  total: string;
  validUntil: string;
}) {
  const common = useTranslations("gateway.common") as unknown as Translate;
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" icon="FileSignature" onClick={() => setOpen(true)}>
        {common("sign")}
      </Button>
      {open ? (
        <QuoteSignDialog
          documentId={documentId}
          total={total}
          validUntil={validUntil}
          setOpen={setOpen}
        />
      ) : null}
    </>
  );
}
