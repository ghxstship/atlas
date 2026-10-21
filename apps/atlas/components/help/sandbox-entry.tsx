"use client";

import { Button } from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  mySandboxAction,
  openSandboxAction,
  type SandboxSummary,
} from "@/lib/help/first-run-actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Try a sandbox, in the help panel (Section 11.7, A96, migration 1530): opens the person's private Northwind Live
 * sandbox, creating it from the template the first time, and says when the open one ends.
 */
export function SandboxEntry() {
  const t = useTranslations("firstRun.sandbox") as unknown as Translate;
  const format = useFormatter();
  const router = useRouter();
  const [mine, setMine] = useState<SandboxSummary | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    mySandboxAction().then(
      (s) => {
        if (live) setMine(s);
      },
      () => {
        if (live) setMine(null);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const open = async () => {
    setBusy(true);
    setError(null);
    const result = await openSandboxAction();
    if (result.ok) {
      router.push(`/${result.slug}/home` as Route);
      return;
    }
    setError(t(result.error === "removing" ? "removing" : "failed"));
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-8">
      <p className="m-0 text-text-13 text-text-secondary">{t("intro")}</p>
      {mine ? (
        <p className="m-0 text-text-12 text-text-secondary">
          {t("ends", {
            when: format.dateTime(new Date(mine.expiresAt), {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
        </p>
      ) : null}
      <Button icon="Sparkles" onClick={() => void open()} disabled={busy || mine === undefined}>
        {busy ? t("opening") : t(mine ? "open" : "try")}
      </Button>
      {error ? (
        <p role="alert" className="m-0 text-text-12 text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
