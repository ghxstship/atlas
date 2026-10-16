"use client";

import { Button } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { resetTipsAction } from "@/lib/help/actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Me, Preferences: the person's guided tours with where they stand, a link that replays each one on
 * its page (`?tour=<key>`), and a reset that shows every dismissed tip again (Section 11.16).
 */
export function ToursAndTips({
  org,
  tours,
  dismissedTips,
}: {
  org: string;
  tours: readonly { key: string; state: string | null; href: string | null }[];
  dismissedTips: number;
}) {
  const t = useTranslations("support.preferences") as unknown as Translate;
  const h = useTranslations("help.tours") as unknown as Translate;
  const [count, setCount] = useState(dismissedTips);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <section aria-labelledby="tours-tips-heading" className="flex flex-col gap-12">
      <h2 id="tours-tips-heading" className="m-0 text-heading-16 font-semibold">
        {t("title")}
      </h2>
      <p className="m-0 text-text-secondary">{t("description")}</p>
      <ul className="m-0 flex list-none flex-col gap-8 p-0">
        {tours.map((tour) => (
          <li key={tour.key} className="flex flex-wrap items-center justify-between gap-8">
            <span className="flex flex-col">
              <span className="font-medium">{h(`${tour.key.replaceAll(".", "_")}.title`)}</span>
              <span className="text-text-12 text-text-secondary">
                {t(`state.${tour.state ?? "none"}`)}
              </span>
            </span>
            {tour.href ? (
              <Link href={tour.href as Route} className="font-medium text-accent-text underline">
                {t("replay")}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-12">
        <span className="text-text-secondary">{t("tipsDismissed", { count })}</span>
        <Button
          loading={busy}
          disabled={count === 0}
          onClick={async () => {
            setBusy(true);
            setFailed(false);
            const result = await resetTipsAction(org);
            setBusy(false);
            if (result.ok) {
              setCount(0);
              setStatus(t("resetDone"));
            } else setFailed(true);
          }}
        >
          {t("resetTips")}
        </Button>
      </div>
      <p role="status" className="m-0 text-text-12 text-text-secondary">
        {status}
      </p>
      {failed ? (
        <p role="alert" className="m-0 text-text-12 text-danger-text">
          {t("resetFailed")}
        </p>
      ) : null}
    </section>
  );
}
