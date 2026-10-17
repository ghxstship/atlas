import {
  getEffectiveBrand,
  listClientOrgs,
  listClientPrices,
  listClientVenues,
  type ClientVenue,
  type EffectiveBrand,
} from "@xos/data/partner";
import {
  ClientOrgsView,
  type ClientDetail,
  type ClientRow,
} from "@/components/partner/client-orgs";
import { ErrorPanel } from "@/components/platform/kit";
import { PartnerFrame } from "@/components/partner/partner-frame";
import { requireNode } from "@/components/shell/sitemap-page";
import { getFormatters } from "@/lib/platform/format";

/**
 * Client orgs (Section 4.6.1): every client with its plan, seats, Owner and support session; create a
 * client with an Owner invitation; open a client to price it, see its inherited brand and, only while
 * its Owner has granted a support session, read its records.
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/partner/[partnerSlug]/client-orgs">) {
  const ctx = await requireNode("partner-console.client-orgs", await params);
  const query = await searchParams;
  const { t, money, dateTime } = await getFormatters(ctx);
  const [clients, prices] = await Promise.all([
    listClientOrgs(ctx.viewer.db, ctx.org.id),
    listClientPrices(ctx.viewer.db, ctx.org.id),
  ]);
  if (!clients.ok || !prices.ok) {
    return (
      <PartnerFrame ctx={ctx} node="partner-console.client-orgs">
        <ErrorPanel sentence={t("partner.loadError")} />
      </PartnerFrame>
    );
  }
  const priceOf = new Map(prices.data.map((p) => [p.clientOrgId, p]));
  const rows: ClientRow[] = clients.data.map((c) => {
    const price = priceOf.get(c.id);
    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      plan: t(`partner.plans.${c.planCode}`),
      seats: c.seats,
      owner: c.ownerJoined ? t("partner.clients.ownerJoined") : t("partner.clients.ownerInvited"),
      session: c.supportSessionEndsAt
        ? t("partner.clients.sessionUntil", { when: dateTime(c.supportSessionEndsAt) })
        : t("partner.clients.noSession"),
      price: price ? money(price.monthlyMinor, price.currency) : t("partner.clients.noPrice"),
    };
  });

  const selectedId = typeof query["client"] === "string" ? query["client"] : null;
  const selected = clients.data.find((c) => c.id === selectedId) ?? null;
  let detail: ClientDetail | null = null;
  if (selected) {
    const [brand, venues] = await Promise.all([
      getEffectiveBrand(ctx.viewer.db, selected.id),
      listClientVenues(ctx.viewer.db, selected.id),
    ]);
    const price = priceOf.get(selected.id);
    const brandData: EffectiveBrand | null = brand.ok ? brand.data : null;
    const venueData: ClientVenue[] | null = venues.ok ? venues.data : null;
    detail = {
      id: selected.id,
      name: selected.name,
      plan: t(`partner.plans.${selected.planCode}`),
      seats: selected.seats,
      fieldMembers: selected.fieldMembers,
      ownerJoined: selected.ownerJoined,
      sessionId: selected.supportSessionId,
      sessionEndsAt: selected.supportSessionEndsAt ? dateTime(selected.supportSessionEndsAt) : null,
      accent: brandData?.accentHex ?? null,
      inherited: brandData?.inherited ?? false,
      venues: venueData,
      priceAmount: price ? (price.monthlyMinor / 100).toFixed(2) : "",
      priceCurrency: price?.currency ?? "USD",
    };
  }

  return (
    <PartnerFrame ctx={ctx} node="partner-console.client-orgs">
      <ClientOrgsView
        org={ctx.org.slug}
        rows={rows}
        creating={query["create"] === "1"}
        detail={detail}
      />
    </PartnerFrame>
  );
}
