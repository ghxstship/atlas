import { canReadEngagementCosts, listEngagementCosts } from "@xos/data/settlements";
import Link from "next/link";
import type { Route } from "next";
import { getFinanceCopy } from "@/lib/finance/copy";
import type { OrgContext } from "@/lib/shell/context";
import { Section, SimpleTable } from "./figures";

/**
 * All-in cost of one engagement (G-186), per currency, on the settlement and engagement peeks. Shown only to readers of
 * every capability the roll-up reads (app.can_read_engagement_costs). The Gateway settlement page never shows it: this
 * is the org's internal cost.
 */
export async function AllInCost({
  ctx,
  projectId,
  projectKey,
  engagementId,
}: {
  ctx: OrgContext;
  projectId: string;
  projectKey: string | null;
  engagementId: string;
}) {
  const db = ctx.viewer.db;
  if (!(await canReadEngagementCosts(db, projectId))) return null;
  const [costs, c] = await Promise.all([
    listEngagementCosts(db, { projectId, engagementId }),
    getFinanceCopy(ctx),
  ]);
  const { t } = c;
  if (!costs.ok || costs.data.length === 0) return null;
  const query = new URLSearchParams({ tab: "act-costs" });
  if (projectKey) query.set("project", projectKey);
  return (
    <Section id="all-in-cost" title={t("finance.actCosts.allIn")}>
      <SimpleTable
        caption={t("finance.actCosts.allIn")}
        head={[t("finance.common.currency"), t("finance.common.total")]}
        numeric={[1]}
        rows={costs.data.map((row) => [
          row.currency ?? t("finance.actCosts.noCurrency"),
          row.totalMinor === null
            ? t("finance.actCosts.unpricedTotal", { count: row.unpricedCount })
            : c.money(row.totalMinor, row.currency ?? ""),
        ])}
      />
      {/* The fee can be in any currency, so the note is decided across them. */}
      {costs.data.every((row) => row.settlementMinor === 0 && row.invoiceMinor === 0) ? (
        <p className="m-0 text-text-12 text-text-secondary">{t("finance.actCosts.noFee")}</p>
      ) : null}
      <Link
        href={`/${ctx.org.slug}/finance/payments?${query.toString()}` as Route}
        className="text-text-12 text-accent-text underline"
      >
        {t("finance.actCosts.open")}
      </Link>
    </Section>
  );
}
