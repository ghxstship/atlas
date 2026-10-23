"use client";

import { Button } from "@xos/ui";
import { useTranslations } from "next-intl";

/** A page that failed to load says so with a retry, never a blank screen (Section 11.10). */
export default function ConsoleError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations("console.error");
  return (
    <main className="mx-auto flex max-w-prose flex-col gap-12 px-16 py-48">
      <h1 className="m-0 text-heading-20 font-semibold">{t("title")}</h1>
      <p className="m-0 text-text-14 text-text-secondary">{t("body")}</p>
      <div>
        <Button onClick={reset}>{t("action")}</Button>
      </div>
    </main>
  );
}
