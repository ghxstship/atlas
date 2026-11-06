"use client";

import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";

/** Shows a value with a button that copies it, and says so. */
export function CopyText({ text, label }: { text: string; label: string }) {
  const t = useTranslations("opportunities.registrationPages");
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-8">
      <span className="min-w-0 break-all font-mono text-text-12">{text}</span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => setCopied(true));
        }}
      >
        {label}
      </Button>
      {copied ? <span role="status" className="text-text-12 text-text-secondary">{t("copied")}</span> : null}
    </span>
  );
}
