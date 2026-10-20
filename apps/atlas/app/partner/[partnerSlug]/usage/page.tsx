import { listClientOrgs, listClientUsage, monthStart } from "@xos/data/partner";
import { EmptyPanel, ErrorPanel } from "@/components/platform/kit";
import { DataTable } from "@/components/platform/client/data-table";
import { PartnerFrame } from "@/components/partner/partner-frame";
import { requireNode } from "@/lib/shell/require-node";
import { getFormatters } from "@/lib/platform/format";

const METERS = ["emails_sent", "sms_segments", "push_sent", "api_requests", "ai_tokens"] as const;

/** Usage rollups (Section 4.6.1): seats and this month's metered usage of every client org. Totals only. */
export default async function Page({ params }: PageProps<"/partner/[partnerSlug]/usage">) {
  const ctx = await requireNode("partner-console.usage", await params);
  const { t, month } = await getFormatters(ctx);
  // Usage rollups and wholesale statements are kept by UTC month (0510, 1060), so the current
  // period here is the UTC month on purpose, not the partner's calendar month.
  const period = monthStart(new Date());
  const [clients, usage] = await Promise.all([
    listClientOrgs(ctx.viewer.db, ctx.org.id),
    listClientUsage(ctx.viewer.db, ctx.org.id, period),
  ]);
  if (!clients.ok || !usage.ok) {
    return (
      <PartnerFrame ctx={ctx} node="partner-console.usage">
        <ErrorPanel sentence={t("partner.usage.loadError")} />
      </PartnerFrame>
    );
  }
  const quantity = (orgId: string, meter: string) =>
    usage.data.find((u) => u.orgId === orgId && u.meter === meter)?.quantity ?? 0;
  return (
    <PartnerFrame ctx={ctx} node="partner-console.usage">
      {clients.data.length === 0 ? (
        <EmptyPanel
          icon="ChartColumn"
          sentence={t("partner.usage.empty")}
          actionLabel={t("partner.clients.create")}
          href={`/partner/${ctx.org.slug}/client-orgs?create=1`}
        />
      ) : (
        <DataTable
          caption={t("partner.usage.caption", { month: month(period) })}
          label={t("partner.usage.caption", { month: month(period) })}
          height="auto"
          columns={[
            { key: "name", label: t("partner.clients.columns.name") },
            { key: "seats", label: t("partner.clients.columns.seats"), type: "number" },
            { key: "field", label: t("partner.clients.fieldMembers"), type: "number" },
            ...METERS.map((m) => ({
              key: m,
              label: t(`partner.usage.meters.${m}`),
              type: "number" as const,
            })),
          ]}
          rows={clients.data.map((c) => ({
            id: c.id,
            name: c.name,
            seats: c.seats,
            field: c.fieldMembers,
            ...Object.fromEntries(METERS.map((m) => [m, quantity(c.id, m)])),
          }))}
        />
      )}
    </PartnerFrame>
  );
}
