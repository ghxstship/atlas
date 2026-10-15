import { listOffers, OFFER_STATES, type OfferSummary } from "@xos/data/people";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { CrewRecord } from "@/components/crew/record";
import { FilterSelect, PeekBoard, PeekTable } from "@/components/crew/views";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { flatParams, getCrewContext, withParams } from "@/lib/crew/context";
import { money } from "@/lib/crew/format";
import { peopleStateIcon } from "@/lib/people/states";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * People > Offers (Section 4.5.5): every offer the org has sent, with its latest terms and where it
 * stands. Offers are made, revised and withdrawn from the application in Opportunities (A28 owns
 * app.offers and its versioned terms); an accepted offer leads to an offer letter in Agreements.
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/people/offers">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "people.offers";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  const stateFilter = OFFER_STATES.find((s) => s === search["state"]);
  const result = await listOffers(db, {
    orgId: crew.orgId,
    ...(stateFilter ? { states: [stateFilter] } : {}),
  });
  if (!result.ok) throw new Error(`Cannot list offers: ${result.error.kind}`);
  const offers = result.data;
  const name = (o: OfferSummary) => o.applicantName ?? t("crew.common.unnamed");
  const title = (o: OfferSummary) =>
    t("people.offers.title", {
      name: name(o),
      opportunity: o.opportunityTitle ?? t("people.offers.untitled"),
    });
  const terms = (o: OfferSummary) =>
    o.latest && o.latest.currencyCode
      ? money(format, t, o.latest.amountMinor, o.latest.currencyCode)
      : t("crew.money.unpriced");
  const pipeline = `/${crew.slug}/opportunities/pipeline`;

  let peek = null;
  const o = search["peek"] ? offers.find((x) => x.id === search["peek"]) : undefined;
  if (o) {
    const record = (
      <CrewRecord
        crew={crew}
        mode={search["full"] === "1" ? "full" : "peek"}
        kindLabel={t("people.kinds.offer")}
        recordKey={o.opportunityTitle ?? ""}
        title={title(o)}
        state={peopleStateIcon("offer", o.state)}
        stateLabel={t(`people.states.offer.${o.state}`)}
        subject={{ table: "app.offers", id: o.id }}
        backHref={withParams(base, search, { peek: null, full: null })}
        actions={
          <>
            <ButtonLink href={`${pipeline}?peek=${o.applicationId}`} size="sm" variant="primary">
              {t("people.offers.openApplication")}
            </ButtonLink>
            {o.state === "Accepted" && crew.can("people.agreement.write") ? (
              <ButtonLink href={`/${crew.slug}/people/agreements?create=1&offer=${o.id}`} size="sm">
                {t("people.offers.prepareLetter")}
              </ButtonLink>
            ) : null}
          </>
        }
        properties={[
          { label: t("people.offers.applicant"), value: name(o) },
          {
            label: t("people.offers.opportunity"),
            value: o.opportunityTitle ?? t("people.offers.untitled"),
          },
          { label: t("people.offers.terms"), value: terms(o) },
          {
            label: t("people.offers.rateType"),
            value: o.latest?.rateType ?? t("people.requisitions.unknown"),
          },
          {
            label: t("people.requisitions.dates"),
            value: o.latest?.startsOn
              ? t("crew.common.range", {
                  start: o.latest.startsOn,
                  end: o.latest.endsOn ?? o.latest.startsOn,
                })
              : t("people.requisitions.unknown"),
          },
          {
            label: t("people.offers.expires"),
            value: o.latest?.expiresAt
              ? format.dateTime(new Date(o.latest.expiresAt), { dateStyle: "medium" })
              : t("people.offers.noExpiry"),
          },
        ]}
      />
    );
    if (search["full"] === "1") return record;
    peek = record;
  }

  let body;
  if (offers.length === 0) {
    body = (
      <EmptyStateLink
        icon="Handshake"
        sentence={stateFilter ? t("crew.swapsPage.emptyFiltered") : t("people.offers.empty")}
        actionLabel={stateFilter ? t("crew.common.clearFilter") : t("people.offers.goPipeline")}
        href={stateFilter ? withParams(base, search, { state: null }) : pipeline}
      />
    );
  } else if (view === "board") {
    body = (
      <PeekBoard
        columns={OFFER_STATES.map((st) => ({
          state: peopleStateIcon("offer", st),
          label: t(`people.states.offer.${st}`),
          cards: offers
            .filter((x) => x.state === st)
            .map((x) => ({ key: x.id, title: title(x), meta: terms(x) })),
        }))}
      />
    );
  } else if (view === "list") {
    body = (
      <ul
        aria-label={t("people.offers.caption")}
        className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
      >
        {offers.map((x) => (
          <li key={x.id}>
            <Link
              href={withParams(base, search, { peek: x.id }) as Route}
              className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <span className="flex flex-col">
                <span className="text-text-13 font-medium">{title(x)}</span>
                <span className="text-text-12 text-text-secondary">{terms(x)}</span>
              </span>
              <span className="text-text-12 text-text-secondary">
                {t(`people.states.offer.${x.state}`)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <PeekTable
        caption={t("people.offers.caption")}
        columns={[
          { key: "applicant", label: t("people.offers.applicant") },
          { key: "opportunity", label: t("people.offers.opportunity"), wrap: true },
          { key: "terms", label: t("people.offers.terms") },
          { key: "sent", label: t("people.offers.sent") },
          { key: "state", label: t("crew.fields.state"), type: "state" },
        ]}
        rows={offers.map((x) => ({
          id: x.id,
          applicant: name(x),
          opportunity: x.opportunityTitle ?? t("people.offers.untitled"),
          terms: terms(x),
          sent: format.dateTime(new Date(x.createdAt), { dateStyle: "medium" }),
          state: {
            state: peopleStateIcon("offer", x.state),
            label: t(`people.states.offer.${x.state}`),
          },
        }))}
      />
    );
  }

  return (
    <CrewFrame
      crew={crew}
      node={node}
      module="people"
      params={routeParams}
      search={search}
      count={offers.length}
      view={view}
      actions={
        <ButtonLink href={pipeline} size="sm">
          {t("people.offers.goPipeline")}
        </ButtonLink>
      }
      filters={
        <FilterSelect
          name="state"
          label={t("crew.fields.state")}
          value={stateFilter ?? ""}
          options={[
            { value: "", label: t("crew.common.allStates") },
            ...OFFER_STATES.map((v) => ({ value: v, label: t(`people.states.offer.${v}`) })),
          ]}
        />
      }
      peek={peek}
    >
      {body}
    </CrewFrame>
  );
}
