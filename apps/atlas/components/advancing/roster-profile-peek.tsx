"use client";

import type { SharedWorkDetails } from "@xos/data/work-details";
import { InlineAlert, PropertyList, Skeleton } from "@xos/ui";
import { useEffect, useState } from "react";
import { rosterProfileAction } from "./roster-actions";
import { useCopy } from "./use-copy";

/**
 * The rostered person's shared profile in the peek (R4), read once when the peek opens, through
 * app.roster_shared_work_details, which logs the read. Allergies show as On file unless the reader may
 * read them; the passport number stays masked.
 */
export function RosterProfilePeek({ org, id }: { org: string; id: string }) {
  const t = useCopy("advancing.crew");
  const errors = useCopy("advancing.errors");
  const details = useCopy("workDetails");
  const [data, setData] = useState<SharedWorkDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void rosterProfileAction(org, id).then((r) => {
      if (!live) return;
      if (r.ok) setData(r.details);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [org, id]);
  if (error) return <InlineAlert tone="danger">{errors(error)}</InlineAlert>;
  if (!data) return <Skeleton width="100%" height={96} />;
  const items: { label: string; value: string }[] = [];
  if (data.uniform) {
    const u = data.uniform;
    items.push({
      label: details("uniform.title"),
      value:
        [u.shirtSize, u.jacketSize, u.pantsSize, u.shoeSize].filter(Boolean).join(" · ") ||
        details("notSet"),
    });
  }
  if (data.dietary) {
    items.push({
      label: details("org.allergies"),
      value:
        data.dietary.allergies ??
        (data.dietary.allergiesOnFile ? details("allergiesOnFile") : details("notSet")),
    });
  }
  return (
    <section aria-label={t("profileTitle")} className="flex flex-col gap-8">
      <h3 className="m-0 text-label-13 font-semibold">{t("profileTitle")}</h3>
      {items.length > 0 ? (
        <PropertyList items={items} />
      ) : (
        <p className="m-0 text-text-13 text-text-secondary">{details("org.notShared")}</p>
      )}
    </section>
  );
}
