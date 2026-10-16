import { readView } from "@xos/data/gateway";
import { RegionError, Section } from "@/components/page/page";
import { formatDate, formatDateTime } from "@/lib/format";
import { RecordsTab } from "./tabs-client";
import { RowList } from "./rows";
import type { TabProps } from "./tab-context";

/**
 * Client Reports (Section 4.5.8, A15 0992): report runs the org shared with this engagement while
 * the share is open, then the report records shared with the party. A revoked or expired share no
 * longer appears; the view decides that.
 */
export async function ReportsTab(props: TabProps) {
  const { view, t, locale } = props;
  const shared = await readView(view.ctx.db, "shared_reports", {
    eq: { engagement_id: view.engagement.id },
    order: ["shared_at", "desc"],
  });
  if (!shared.ok) return <RegionError />;
  return (
    <div className="flex flex-col gap-16">
      {shared.data.length > 0 ? (
        <Section title={t("gateway.engagement.reports.shared")}>
          <RowList
            label={t("gateway.engagement.reports.shared")}
            items={shared.data.map((r) => ({
              id: r.id ?? "",
              title: r.title ?? "",
              meta: [
                r.finished_at
                  ? t("gateway.engagement.reports.ranAt", {
                      time: formatDateTime(locale, r.finished_at),
                    })
                  : null,
                r.row_count !== null
                  ? t("gateway.engagement.reports.rows", { n: r.row_count })
                  : null,
                r.unpriced_count
                  ? t("gateway.engagement.reports.unpriced", { n: r.unpriced_count })
                  : null,
                r.expires_at
                  ? t("gateway.engagement.reports.expires", {
                      date: formatDate(locale, r.expires_at),
                    })
                  : null,
              ],
              ...(r.export_format
                ? { tag: { label: r.export_format, tone: "neutral" as const } }
                : {}),
            }))}
          />
        </Section>
      ) : null}
      <RecordsTab
        {...props}
        kinds={["Report"]}
        emptyKey={
          shared.data.length > 0
            ? "gateway.engagement.reports.noRecords"
            : "gateway.engagement.reports.empty"
        }
        icon="FileBarChart"
      />
    </div>
  );
}
