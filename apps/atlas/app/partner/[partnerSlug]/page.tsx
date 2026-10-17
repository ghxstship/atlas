import { getPartnerAgreement, listClientOrgs } from "@xos/data/partner";
import { EmptyPanel, ErrorPanel } from "@/components/platform/kit";
import { InlineAlert, StatTile } from "@/components/platform/ui";
import { PartnerFrame } from "@/components/partner/partner-frame";
import { requireNode } from "@/components/shell/sitemap-page";
import { getFormatters } from "@/lib/platform/format";

/** Partner console overview (Section 4.6.1): clients, joined Owners, open support sessions and terms. */
export default async function Page({ params }: PageProps<"/partner/[partnerSlug]">) {
  const ctx = await requireNode("partner-console", await params);
  const { t, number } = await getFormatters(ctx);
  const [clients, agreement] = await Promise.all([
    listClientOrgs(ctx.viewer.db, ctx.org.id),
    getPartnerAgreement(ctx.viewer.db, ctx.org.id),
  ]);
  const clientsHref = `/partner/${ctx.org.slug}/client-orgs`;
  if (!clients.ok || !agreement.ok) {
    return (
      <PartnerFrame ctx={ctx} node="partner-console">
        <ErrorPanel sentence={t("partner.loadError")} />
      </PartnerFrame>
    );
  }
  const list = clients.data;
  return (
    <PartnerFrame ctx={ctx} node="partner-console">
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
      ) : (
        <div className="grid grid-cols-4 gap-16 max-lg:grid-cols-2 max-sm:grid-cols-1">
          <StatTile
            label={t("partner.overview.clients")}
            value={list.length}
            caption={t("partner.overview.clientsCaption")}
          />
          <StatTile
            label={t("partner.overview.ownersJoined")}
            value={list.filter((c) => c.ownerJoined).length}
            caption={t("partner.overview.ownersJoinedCaption")}
          />
          <StatTile
            label={t("partner.overview.sessions")}
            value={list.filter((c) => c.supportSessionId !== null).length}
            caption={t("partner.overview.sessionsCaption")}
          />
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
        </div>
      )}
    </PartnerFrame>
  );
}
