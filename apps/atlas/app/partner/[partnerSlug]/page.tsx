import { getPartnerAgreement, listClientOrgs } from "@xos/data/partner";
import { resolveSettings } from "@xos/data/settings";
import type { DashboardTile } from "@xos/ui";
import type { ReactNode } from "react";
import { DashboardGrid } from "@/components/dashboard/dashboard-grid";
import { EmptyPanel, ErrorPanel } from "@/components/platform/kit";
import { InlineAlert } from "@/components/platform/client/inline-alert";
import { StatTile } from "@/components/platform/client/stat-tile";
import { PartnerHeader } from "@/components/partner/partner-frame";
import { savedLayout } from "@/lib/dashboard/layout";
import { requireNode } from "@/lib/shell/require-node";
import { getFormatters } from "@/lib/platform/format";

/**
 * Partner console overview (Section 4.6.1) on the Dashboard template (Section 11.6, A129): clients,
 * joined Owners, open support sessions and seats with the terms, each a tile on the 12-column grid at
 * the spans the person saved in me.dashboard_layout.partner.
 */
export default async function Page({ params }: PageProps<"/partner/[partnerSlug]">) {
  const ctx = await requireNode("partner-console", await params);
  const { t, number } = await getFormatters(ctx);
  const [clients, agreement, settings] = await Promise.all([
    listClientOrgs(ctx.viewer.db, ctx.org.id),
    getPartnerAgreement(ctx.viewer.db, ctx.org.id),
    resolveSettings(ctx.viewer.db, { orgId: ctx.org.id }),
  ]);
  const saved = savedLayout("partner", (key) =>
    settings.ok ? settings.data.get(key)?.value : null,
  );
  const clientsHref = `/partner/${ctx.org.slug}/client-orgs`;
  const header = (notice: ReactNode) => (
    <div className="flex flex-col gap-16 min-w-0">
      <PartnerHeader ctx={ctx} node="partner-console" />
      {notice}
    </div>
  );
  if (!clients.ok || !agreement.ok) {
    return (
      <DashboardGrid
        dashboard="partner"
        header={header(<ErrorPanel sentence={t("partner.loadError")} />)}
        tiles={[]}
        saved={saved}
        label={t("partner.overview.tiles")}
      />
    );
  }
  const list = clients.data;
  const tiles: DashboardTile[] =
    list.length === 0
      ? []
      : [
          {
            id: "clients",
            label: t("partner.overview.clients"),
            span: 3,
            content: (
              <StatTile
                label={t("partner.overview.clients")}
                value={list.length}
                caption={t("partner.overview.clientsCaption")}
              />
            ),
          },
          {
            id: "owners-joined",
            label: t("partner.overview.ownersJoined"),
            span: 3,
            content: (
              <StatTile
                label={t("partner.overview.ownersJoined")}
                value={list.filter((c) => c.ownerJoined).length}
                caption={t("partner.overview.ownersJoinedCaption")}
              />
            ),
          },
          {
            id: "sessions",
            label: t("partner.overview.sessions"),
            span: 3,
            content: (
              <StatTile
                label={t("partner.overview.sessions")}
                value={list.filter((c) => c.supportSessionId !== null).length}
                caption={t("partner.overview.sessionsCaption")}
              />
            ),
          },
          {
            id: "seats",
            label: t("partner.overview.seats"),
            span: 3,
            content: (
              <StatTile
                label={t("partner.overview.seats")}
                value={list.reduce((n, c) => n + c.seats, 0)}
                caption={
                  agreement.data
                    ? t("partner.overview.discount", {
                        percent: number(agreement.data.discountBps / 100),
                      })
                    : t("partner.overview.noDiscount")
                }
              />
            ),
          },
        ];
  return (
    <DashboardGrid
      dashboard="partner"
      header={header(
        <>
          {agreement.data === null ? (
            <InlineAlert tone="info" title={t("partner.noAgreement.title")}>
              {t("partner.noAgreement.body")}
            </InlineAlert>
          ) : null}
          {list.length === 0 ? (
            <EmptyPanel
              icon="Building2"
              sentence={t("partner.overview.empty")}
              actionLabel={t("partner.overview.emptyAction")}
              href={`${clientsHref}?create=1`}
            />
          ) : null}
        </>,
      )}
      tiles={tiles}
      saved={saved}
      label={t("partner.overview.tiles")}
    />
  );
}
