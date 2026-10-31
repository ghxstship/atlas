import {
  isCurrentEngagement,
  listEngagementDocuments,
  listMyApplications,
  listMyEngagements,
  listOnboardingItems,
  listRepresentations,
  listSharedRecords,
  readView,
  searchMarketplace,
  type Engagement,
} from "@xos/data/gateway";
import { startOfDayIn } from "@xos/data/calendar";
import {
  listMyParkingPasses,
  listMyRosterEngagements,
  type RosterEngagement,
} from "@xos/data/gateway-allocations";
import {
  listMyRosterEntries,
  listMyUnconfirmedMemberships,
  myPendingInvitations,
} from "@xos/data/roster";
import dynamic from "next/dynamic";
import type { Metadata, Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getLocale } from "next-intl/server";
import { ActionButton } from "@/components/actions/action-button";
import { OpportunityLinkCard } from "@/components/page/opportunity-card";
import { PageTitle, RegionError, Section, pickView, ViewSwitcher } from "@/components/page/page";
import { ButtonLink, Card, EmptyStateLink, Icon, PropertyList } from "@/components/ui";
import { UpNextActions } from "@/components/page/up-next-actions";
import { ForYourInformation } from "@/components/page/for-your-information";
import { acceptRepresentationAction, signDocumentAction } from "@/lib/actions/engagement";
import {
  acceptAccountMembershipAction,
  leaveAccountMembershipAction,
  respondPartyInvitationAction,
  respondRosterEntryAction,
} from "@/lib/actions/roster";
import {
  formatCountdown,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatScheduleTime,
  type ScheduleView,
} from "@/lib/format";
import { getScheduleView } from "@/lib/time-zone";
import {
  needsYou,
  pickUpNext,
  upNextDetails,
  UP_NEXT_KINDS,
  type FeedItem,
  type UpNextDetails,
} from "@/lib/home";
import type { GatewayContext } from "@/lib/shell/context";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { getNode } from "@xos/ia";
import { enumLabelKey, getTranslate, type Translate } from "@/lib/shell/translate";
import { engagementTitle } from "@/lib/engagement-state";
import { RosterFactsButton } from "@/components/roster/roster-facts-button";

// Leaving an account is irreversible, so it is confirmed in a dialog whose code loads on demand (R4).
const ConfirmButton = dynamic(() =>
  import("@/components/actions/confirm-button").then((m) => m.ConfirmButton),
);

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("nav.gateway.primary.home") };
}

function engagementHref(e: Engagement, tab = "overview"): Route {
  return `/work/engagements/${e.key}/${tab}` as Route;
}

/**
 * Gateway Home (Section 4.5.8): search first, the Up Next card, a feed of things that need the
 * person with each action inline, For Your Information beside it with Done (E) and Snooze (H) (A127), then
 * recommended opportunities. Every engagement detail is one
 * tap from here (Section 11.12, Work).
 */
export default async function HomePage({ searchParams }: PageProps<"/home">) {
  const ctx = await requireNode("home");
  const query = await searchParams;
  const views = getNode(sitemap, "home").node.list?.views ?? ["feed"];
  const view = pickView(query["view"], views, "feed");
  const [t, locale, schedule] = await Promise.all([
    getTranslate(),
    getLocale(),
    getScheduleView(ctx),
  ]);
  const now = new Date();
  const engagementsResult = await listMyEngagements(ctx.db);
  if (!engagementsResult.ok) {
    return (
      <>
        <PageTitle title={t("nav.gateway.primary.home")} />
        <RegionError />
      </>
    );
  }
  const engagements = engagementsResult.data;
  const current = engagements.filter(isCurrentEngagement);
  const [
    records,
    documents,
    onboarding,
    applications,
    representations,
    recommended,
    invitations,
    memberships,
    rosterEntries,
    rosterEngagements,
  ] = await Promise.all([
    listSharedRecords(ctx.db, {
      projectIds: [...new Set(current.map((e) => e.projectId))],
      kinds: [...UP_NEXT_KINDS],
    }),
    listEngagementDocuments(ctx.db),
    listOnboardingItems(ctx.db),
    listMyApplications(ctx.db),
    listRepresentations(ctx.db),
    searchMarketplace(ctx.db, {
      limit: 6,
      ...(ctx.brand.kind === "org" ? { orgId: ctx.brand.org.orgId } : {}),
    }),
    myPendingInvitations(ctx.db),
    listMyUnconfirmedMemberships(ctx.db, ctx.personId),
    listMyRosterEntries(ctx.db),
    listMyRosterEngagements(ctx.db),
  ]);
  const rostered = rosterEngagements.ok ? rosterEngagements.data : [];
  const upNext = records.ok ? pickUpNext(records.data, current, now, rostered) : null;
  const details = upNext?.engagement
    ? await loadUpNextDetails(
        ctx,
        upNext.engagement,
        rostered.find((r) => r.id === upNext.engagement?.id) ?? null,
      )
    : null;
  const feed = needsYou({
    engagements,
    documents: documents.ok ? documents.data : [],
    onboarding: onboarding.ok ? onboarding.data : [],
    applications: applications.ok ? applications.data : [],
    representations: representations.ok ? representations.data : [],
    invitations: invitations.ok ? invitations.data : [],
    memberships: memberships.ok ? memberships.data : [],
    rosterEntries: rosterEntries.ok ? rosterEntries.data : [],
    personId: ctx.personId,
    now,
  });
  const failed =
    !records.ok ||
    !documents.ok ||
    !onboarding.ok ||
    !applications.ok ||
    !representations.ok ||
    !invitations.ok ||
    !memberships.ok ||
    !rosterEntries.ok ||
    !rosterEngagements.ok;
  const firstName = (ctx.personName ?? "").split(" ")[0] ?? "";

  return (
    <>
      <PageTitle
        title={
          firstName
            ? t("gateway.home.greeting", { name: firstName })
            : t("nav.gateway.primary.home")
        }
        action={<ViewSwitcher views={views} current={view} path="/home" query={query} />}
      />
      <form action="/explore" method="get" role="search" className="flex">
        <label className="flex min-h-touch-min w-full items-center gap-8 rounded-control border border-border-control bg-bg-surface ps-12 pe-8 focus-within:outline-solid focus-within:outline-stroke-focus focus-within:outline-focus-ring">
          <span className="text-text-secondary">
            <Icon name="Search" />
          </span>
          <span className="sr-only">{t("gateway.home.searchLabel")}</span>
          <input
            name="q"
            type="search"
            placeholder={t("gateway.home.searchHint")}
            className="min-w-0 flex-1 border-0 bg-transparent text-text-14 text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </label>
      </form>

      {view === "feed" ? (
        <Section title={t("gateway.home.upNext.title")}>
          {upNext ? (
            <UpNextCardView
              upNext={upNext}
              details={details}
              locale={locale}
              t={t}
              now={now}
              schedule={schedule}
            />
          ) : (
            <EmptyStateLink
              icon="CalendarClock"
              sentence={t("gateway.home.upNext.empty")}
              actionLabel={t("gateway.home.upNext.emptyAction")}
              href="/explore"
            />
          )}
        </Section>
      ) : null}

      <Section title={t("gateway.home.needsYou.title")}>
        {failed ? <RegionError /> : null}
        {feed.length === 0 && !failed ? (
          <EmptyStateLink
            icon="Inbox"
            sentence={t("gateway.home.needsYou.empty")}
            actionLabel={t("gateway.home.needsYou.emptyAction")}
            href="/work/upcoming"
            secondary
          />
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle bg-bg-raised p-0">
            {feed.map((item) => (
              <FeedRow key={feedKey(item)} item={item} locale={locale} t={t} />
            ))}
          </ul>
        )}
      </Section>

      <ForYourInformation db={ctx.db} t={t} locale={locale} />

      {view === "feed" ? (
        <Section
          title={t("gateway.home.recommended.title")}
          action={
            <Link href="/explore" className="text-text-13 text-accent-text underline">
              {t("gateway.home.recommended.all")}
            </Link>
          }
        >
          {!recommended.ok ? (
            <RegionError />
          ) : recommended.data.length === 0 ? (
            <EmptyStateLink
              icon="Compass"
              sentence={t("gateway.home.recommended.empty")}
              actionLabel={t("gateway.home.recommended.emptyAction")}
              href="/explore/alerts"
              secondary
            />
          ) : (
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,var(--ui-gateway-aside)),1fr))] gap-12 p-0">
              {recommended.data.map((o) => (
                <li key={o.id}>
                  <OpportunityLinkCard opportunity={o} locale={locale} t={t} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}
    </>
  );
}

/**
 * The next call, the venue, the contact and what to bring for the Up Next engagement (R2), read in
 * parallel. A read that fails leaves its rows out rather than failing the card.
 */
async function loadUpNextDetails(
  ctx: GatewayContext,
  e: Engagement,
  roster: RosterEngagement | null,
): Promise<UpNextDetails> {
  const [row, badges, gear, parking] = await Promise.all([
    readView(ctx.db, "engagement_up_next", { eq: { engagement_id: e.id } }),
    readView(ctx.db, "credentials", {
      eq: { project_id: e.projectId, holder_person_id: ctx.personId },
    }),
    readView(ctx.db, "asset_custody", { eq: { engagement_id: e.id } }),
    listMyParkingPasses(ctx.db, e.projectId),
  ]);
  return upNextDetails({
    row: row.ok ? (row.data[0] ?? null) : null,
    orgName: e.orgName,
    // Parking passes have their own row.
    badges: badges.ok ? badges.data.filter((b) => b.category_kind !== "Parking") : [],
    gear: gear.ok ? gear.data : [],
    parking: parking.ok ? parking.data : [],
    lead: roster?.leadName ?? null,
  });
}

/** The Up Next rows R2 adds, each left out when it has no value. */
function detailItems(
  details: UpNextDetails | null,
  e: Engagement | null,
  locale: string,
  t: Translate,
  schedule: ScheduleView,
): { label: string; value: ReactNode }[] {
  if (!details || !e) return [];
  return [
    ...(details.call
      ? [
          {
            label: t(`gateway.home.upNext.callKind.${details.call.kind}`),
            value: details.call.tbc
              ? t("gateway.common.tbc")
              : formatScheduleTime(locale, details.call.at, details.call.timeZone, schedule),
          },
        ]
      : []),
    ...(details.where ? [{ label: t("gateway.home.upNext.where"), value: details.where }] : []),
    ...(details.parking.length > 0
      ? [{ label: t("gateway.home.upNext.parking"), value: details.parking.join("; ") }]
      : []),
    {
      label: t("gateway.home.upNext.contact"),
      value: (
        <span className="flex flex-wrap items-center gap-8">
          <span>{details.contact}</span>
          <Link href={engagementHref(e, "messages")} className="text-accent-text underline">
            {t("gateway.home.upNext.message")}
          </Link>
        </span>
      ),
    },
    ...(details.bring.length > 0
      ? [
          {
            label: t("gateway.home.upNext.bring"),
            value: (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {details.bring.map((b) => (
                  <li key={b}>{b}</li>
                ))}
                {details.bringMore > 0 ? (
                  <li className="text-text-secondary">
                    {t("gateway.home.upNext.bringMore", { n: details.bringMore })}
                  </li>
                ) : null}
              </ul>
            ),
          },
        ]
      : []),
  ];
}

function feedKey(item: FeedItem): string {
  switch (item.kind) {
    case "sign":
      return `sign-${item.document.id}`;
    case "offer":
      return `offer-${item.application.id}`;
    case "onboarding":
      return `onboarding-${item.engagement.id}`;
    case "representation":
      return `rep-${item.representation.id}`;
    case "interview":
      return `interview-${item.application.id}`;
    case "rate":
      return `rate-${item.engagement.id}`;
    case "invitation":
      return `invitation-${item.invitation.id}`;
    case "membership":
      return `membership-${item.membership.accountMembershipId}`;
    case "roster":
      return `roster-${item.entry.id}`;
  }
}

function UpNextCardView({
  upNext,
  details,
  locale,
  t,
  now,
  schedule,
}: {
  upNext: ReturnType<typeof pickUpNext> & object;
  /** Call, venue, contact and what to bring for the Up Next engagement (R2). */
  details: UpNextDetails | null;
  locale: string;
  t: Translate;
  now: Date;
  /** How the person reads schedule times (me.time_zone_display). */
  schedule: ScheduleView;
}) {
  if (upNext.kind === "engagement") {
    const e = upNext.engagement;
    return (
      <Card
        title={engagementTitle(e, (r) => t(enumLabelKey("externalRoleType", r)))}
        meta={
          <span className="font-semibold text-accent-text">
            {formatCountdown(locale, startOfDayIn(e.startDate, e.projectTimeZone), now)}
          </span>
        }
        footer={
          <ButtonLink href={engagementHref(e)} variant="primary">
            {t("gateway.home.upNext.open")}
          </ButtonLink>
        }
      >
        <PropertyList
          items={[
            { label: t("gateway.home.upNext.org"), value: e.orgName },
            { label: t("gateway.home.upNext.project"), value: e.projectName },
            {
              label: t("gateway.home.upNext.when"),
              value: formatDateRange(locale, e.startDate, e.endDate),
            },
            {
              label: t("gateway.home.upNext.state"),
              value: t(enumLabelKey("engagementState", e.state)),
            },
            ...detailItems(details, e, locale, t, schedule),
          ]}
        />
      </Card>
    );
  }
  const r = upNext.record;
  const start = r.startsAt ?? r.dueAt ?? r.endsAt;
  return (
    <Card
      title={r.title}
      meta={
        start ? (
          <span className="font-semibold text-accent-text">
            {formatCountdown(locale, start, now)}
          </span>
        ) : undefined
      }
      footer={
        <UpNextActions
          title={r.title}
          startsAt={start}
          endsAt={r.endsAt}
          location={upNext.engagement?.projectName ?? null}
          openHref={upNext.engagement ? engagementHref(upNext.engagement) : "/work/upcoming"}
          labels={{
            open: t("gateway.home.upNext.open"),
            calendar: t("gateway.home.upNext.calendar"),
          }}
        />
      }
    >
      <PropertyList
        items={[
          { label: t("gateway.home.upNext.kind"), value: t(enumLabelKey("recordKind", r.kind)) },
          ...(start
            ? [
                {
                  label: t("gateway.home.upNext.when"),
                  value: formatScheduleTime(
                    locale,
                    start,
                    r.timeZone ?? upNext.engagement?.projectTimeZone,
                    schedule,
                  ),
                },
              ]
            : []),
          ...(upNext.engagement
            ? [
                { label: t("gateway.home.upNext.org"), value: upNext.engagement.orgName },
                { label: t("gateway.home.upNext.project"), value: upNext.engagement.projectName },
              ]
            : []),
          ...detailItems(details, upNext.engagement, locale, t, schedule),
        ]}
      />
    </Card>
  );
}

function FeedRow({ item, locale, t }: { item: FeedItem; locale: string; t: Translate }) {
  const row = (icon: string, title: string, meta: string, action: ReactNode) => (
    <li className="flex flex-wrap items-center gap-12 px-16 py-12">
      <span className="text-text-secondary">
        <Icon name={icon} size={18} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="font-medium">{title}</span>
        <span className="text-text-13 text-text-secondary">{meta}</span>
      </div>
      {action}
    </li>
  );
  switch (item.kind) {
    case "sign":
      return row(
        "FileSignature",
        t("gateway.home.needsYou.sign", { title: item.document.title }),
        `${item.engagement.orgName} · ${t(enumLabelKey("engagementDocumentKind", item.document.kind))}`,
        <ActionButton
          action={signDocumentAction.bind(null, item.document.id)}
          label={t("gateway.common.sign")}
          variant="secondary"
          done={t("gateway.common.signed")}
        />,
      );
    case "offer": {
      const o = item.application.opportunity;
      return row(
        "Handshake",
        t("gateway.home.needsYou.offer", { title: o?.title ?? "" }),
        o?.orgName ?? "",
        <ButtonLink href="/work/applications?view=list" variant="secondary" size="sm">
          {t("gateway.home.needsYou.offerAction")}
        </ButtonLink>,
      );
    }
    case "onboarding":
      return row(
        "ListChecks",
        t("gateway.home.needsYou.onboarding", { n: item.open, org: item.engagement.orgName }),
        item.blocking > 0
          ? t("gateway.home.needsYou.onboardingBlocking", { n: item.blocking })
          : engagementTitle(item.engagement, (r) => t(enumLabelKey("externalRoleType", r))),
        <ButtonLink
          href={engagementHref(item.engagement, "onboarding")}
          variant="secondary"
          size="sm"
        >
          {t("gateway.home.needsYou.onboardingAction")}
        </ButtonLink>,
      );
    case "representation":
      return row(
        "UserCheck",
        t("gateway.home.needsYou.representation", { account: item.representation.accountName }),
        item.representation.scopes.map((s) => t(enumLabelKey("representationScope", s))).join(", "),
        <ActionButton
          action={acceptRepresentationAction.bind(null, item.representation.id)}
          label={t("gateway.home.needsYou.representationAction")}
          variant="secondary"
        />,
      );
    case "interview":
      return row(
        "CalendarClock",
        t("gateway.home.needsYou.interview", { title: item.application.opportunity?.title ?? "" }),
        formatDateTime(locale, item.at),
        <ButtonLink href="/work/applications" size="sm">
          {t("gateway.common.view")}
        </ButtonLink>,
      );
    case "rate":
      return row(
        "Star",
        t("gateway.home.needsYou.rate", { org: item.engagement.orgName }),
        `${engagementTitle(item.engagement, (r) => t(enumLabelKey("externalRoleType", r)))} · ${formatDate(locale, item.engagement.endDate ?? item.engagement.startDate)}`,
        <ButtonLink href={engagementHref(item.engagement)} size="sm">
          {t("gateway.home.needsYou.rateAction")}
        </ButtonLink>,
      );
    case "invitation": {
      const i = item.invitation;
      return row(
        "Mail",
        i.kind === "account"
          ? t("gateway.home.feed.invitation.account", { account: i.accountName ?? "" })
          : t("gateway.home.feed.invitation.roster", {
              party: i.partyName ?? "",
              project: i.projectName ?? "",
            }),
        [
          i.kind === "account" && i.accountRole
            ? t(enumLabelKey("accountRole", i.accountRole))
            : i.jobTitle,
          i.kind === "roster" ? t("gateway.home.feed.invitation.consent") : null,
          i.inviterName ? t("gateway.home.feed.invitation.from", { name: i.inviterName }) : null,
          t("gateway.home.feed.invitation.expires", { date: formatDate(locale, i.expiresAt) }),
        ]
          .filter(Boolean)
          .join(" · "),
        <span className="flex flex-wrap gap-8">
          <ActionButton
            action={respondPartyInvitationAction.bind(null, i.kind, i.id, true)}
            label={t("gateway.home.feed.invitation.accept")}
            variant="secondary"
          />
          <ActionButton
            action={respondPartyInvitationAction.bind(null, i.kind, i.id, false)}
            label={t("gateway.home.feed.invitation.decline")}
            variant="ghost"
          />
        </span>,
      );
    }
    case "membership":
      return row(
        "Building2",
        t("gateway.home.feed.membership.title", { account: item.membership.accountName }),
        t("gateway.home.feed.membership.meta"),
        <span className="flex flex-wrap gap-8">
          <ActionButton
            action={acceptAccountMembershipAction.bind(null, item.membership.accountMembershipId)}
            label={t("gateway.home.feed.membership.confirm")}
            variant="secondary"
          />
          <ConfirmButton
            action={leaveAccountMembershipAction.bind(null, item.membership.accountMembershipId)}
            label={t("gateway.home.feed.membership.leave")}
            title={t("gateway.home.feed.membership.leaveTitle", {
              account: item.membership.accountName,
            })}
            sentence={t("gateway.home.feed.membership.leaveSentence")}
            confirm={t("gateway.home.feed.membership.leaveConfirm")}
            cancel={t("gateway.common.cancel")}
          />
        </span>,
      );
    case "roster": {
      const e = item.entry;
      return row(
        "Users",
        t("gateway.home.feed.roster.title", {
          party: e.partyName ?? e.orgName ?? "",
          project: e.projectName ?? "",
        }),
        [e.jobTitle, t("gateway.home.feed.roster.consent")].filter(Boolean).join(" · "),
        <span className="flex flex-wrap items-center gap-8">
          <ActionButton
            action={respondRosterEntryAction.bind(null, e.id, "Accepted")}
            label={t("gateway.home.feed.roster.accept")}
            variant="secondary"
          />
          <ActionButton
            action={respondRosterEntryAction.bind(null, e.id, "Declined")}
            label={t("gateway.home.feed.roster.decline")}
            variant="ghost"
          />
          <RosterFactsButton
            rosterEntryId={e.id}
            name={e.partyName ?? e.orgName ?? ""}
            companyName={e.partyName ?? ""}
            projectName={e.projectName ?? ""}
            self
          />
          <Link href={"/settings/work-details" as Route} className="text-text-13 text-text-link">
            {t("gateway.home.feed.roster.share")}
          </Link>
        </span>,
      );
    }
  }
}
