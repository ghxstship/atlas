"use client";

import { Button } from "@xos/ui";
import type { CateringCount } from "@xos/data/allocations";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { rosterCountsAction } from "./roster-counts-actions";

/**
 * Roster counts beside a BEO's typed guest count (R7): the people allocated the catering and their shared dietary
 * needs, Fewer than 5 where a count is suppressed, and the allergy row only for holders of
 * data.restricted.read.medical (the database leaves it out otherwise). Read on request, as each read is logged.
 */
export function BeoRosterCounts({ org, fulfillmentId }: { org: string; fulfillmentId: string }) {
  const t = useTranslations("hospitality.beos.rosterCounts");
  const [counts, setCounts] = useState<CateringCount[] | null | "failed">(null);
  const [pending, start] = useTransition();
  if (counts === null || counts === "failed") {
    return (
      <div className="flex flex-col gap-4">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          aria-busy={pending}
          onClick={() =>
            start(async () => setCounts((await rosterCountsAction(org, fulfillmentId)) ?? "failed"))
          }
        >
          {t("load")}
        </Button>
        {counts === "failed" ? (
          <p className="m-0 text-text-12 text-text-secondary">{t("failed")}</p>
        ) : null}
      </div>
    );
  }
  const head = counts.find((c) => c.dietaryNeed === null);
  const rows = counts.filter((c) => c.dietaryNeed !== null);
  if (!head || head.headcount === 0)
    return <p className="m-0 text-text-13 text-text-secondary">{t("empty")}</p>;
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-text-12 text-text-secondary">{t("sentence")}</p>
      <dl className="m-0 grid grid-cols-[auto_auto] gap-x-12 gap-y-2 text-text-13">
        <dt className="text-text-secondary">{t("headcount")}</dt>
        <dd className="m-0 tabular-nums">{head.headcount}</dd>
        {rows.map((c) => (
          <div key={c.dietaryNeed} className="contents">
            <dt className="text-text-secondary">
              {c.dietaryNeed === "Allergies" ? t("allergies") : c.dietaryNeed}
            </dt>
            <dd className="m-0 tabular-nums">{c.suppressed ? t("fewerThanFive") : c.headcount}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
