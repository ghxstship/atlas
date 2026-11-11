"use client";

import { useTranslations } from "next-intl";

/**
 * A refusal's rule code under its message, only when the catalog has no sentence of its own for it, and labelled as a
 * reference for support (crawl 4.9). A refusal the copy already explains shows no bare snake_case code.
 */
export function RefusalReference({ rule, known }: { rule: string; known: boolean }) {
  const t = useTranslations("shell");
  if (known) return null;
  return (
    <span className="block text-text-11 text-text-tertiary">
      {t("refusalReference", { code: rule })}
    </span>
  );
}
