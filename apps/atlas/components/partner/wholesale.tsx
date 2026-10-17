"use client";

import { runWholesaleBillingAction } from "@/app/partner/[partnerSlug]/actions";
import { ActionForm, usePlatformT } from "@/components/platform/kit";

/** Runs wholesale billing for the current month; the database refuses a month already billed. */
export function WholesaleRun({
  org,
  period,
  periodLabel,
  billed,
}: {
  org: string;
  period: string;
  periodLabel: string;
  billed: boolean;
}) {
  const t = usePlatformT();
  return (
    <div className="flex flex-col gap-4 rounded-card border border-border-subtle p-16">
      <p className="m-0 text-text-13">
        {billed
          ? t("partner.wholesale.billed", { month: periodLabel })
          : t("partner.wholesale.ready", { month: periodLabel })}
      </p>
      <ActionForm
        action={runWholesaleBillingAction}
        hidden={{ org, period }}
        label={t("partner.wholesale.run", { month: periodLabel })}
        submitLabel={t("partner.wholesale.run", { month: periodLabel })}
        success={t("partner.wholesale.ran")}
        disabled={billed}
      />
    </div>
  );
}
