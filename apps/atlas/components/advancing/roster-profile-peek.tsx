"use client";

import type { SharedWorkDetails } from "@xos/data/work-details";
import { InlineAlert, Skeleton } from "@xos/ui";
import { useEffect, useState } from "react";
import {
  CategoryBlock,
  MedicalBlock,
  categoryBody,
  workDetailLabel,
} from "@/components/work-details/shared-categories";
import { rosterProfileAction } from "./roster-actions";
import { useCopy } from "./use-copy";

/**
 * The rostered person's shared profile in the peek (R4), read once when the peek opens, through
 * app.roster_shared_work_details, which logs the read of every category it returns. Each readable
 * category shows in full, as the engagement's work details section shows it: allergies show locked
 * unless the reader holds data.restricted.read.medical on the project (R6a), who also gets the
 * Medical block, and the passport number stays masked.
 */
export function RosterProfilePeek({ org, id }: { org: string; id: string }) {
  const t = useCopy("advancing.crew");
  const errors = useCopy("advancing.errors");
  const details = useCopy("workDetails");
  const [data, setData] = useState<{
    details: SharedWorkDetails;
    phones: Readonly<Record<string, string>>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void rosterProfileAction(org, id).then((r) => {
      if (!live) return;
      if (r.ok) setData({ details: r.details, phones: r.phones });
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [org, id]);
  if (error) return <InlineAlert tone="danger">{errors(error)}</InlineAlert>;
  if (!data) return <Skeleton width="100%" height={96} />;
  const { readable } = data.details;
  return (
    <section aria-label={t("profileTitle")} className="flex flex-col gap-8">
      <h3 className="m-0 text-label-13 font-semibold">{t("profileTitle")}</h3>
      {readable.length > 0 || data.details.medical !== null ? (
        <div className="flex flex-col gap-8">
          {readable.map((c) => (
            <CategoryBlock key={c} heading="h4" title={workDetailLabel(details, "categories", c)}>
              {categoryBody(c, data.details, details, (e164) => data.phones[e164] ?? e164)}
            </CategoryBlock>
          ))}
          <MedicalBlock d={data.details} t={details} heading="h4" />
        </div>
      ) : (
        <p className="m-0 text-text-13 text-text-secondary">{t("profileNone")}</p>
      )}
    </section>
  );
}
