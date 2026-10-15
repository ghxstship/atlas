import {
  listMyEngagements,
  listRepresentations,
  readView,
  representationStanding,
} from "@xos/data/gateway";
import { RegionError, Section } from "@/components/page/page";
import { Tag } from "@/components/ui";
import { hasArea, tabHref } from "@/lib/engagement";
import { formatDate, formatDateRange, formatDateTime, todayIso } from "@/lib/format";
import { enumLabelKey } from "@/lib/shell/translate";
import { toneFor } from "@/lib/states";
import { RowList, TabEmpty } from "./rows";
import { DocumentsTab } from "./tabs-common";
import type { TabProps } from "./tab-context";

/**
 * Artist and representative tabs (Section 4.4.4 Artist): rider, set times, hospitality, guest
 * list and settlement, and the representative's roster of artists.
 */

export async function RiderTab({ view, t, engagementKey }: TabProps) {
  const riders = await readView(view.ctx.db, "riders", {
    eq: { project_id: view.engagement.projectId },
  });
  if (!riders.ok) return <RegionError />;
  const ids = riders.data.flatMap((r) => (r.id ? [r.id] : []));
  const lines = await readView(view.ctx.db, "rider_lines", { in: ["rider_id", ids] });
  if (!lines.ok) return <RegionError />;
  if (riders.data.length === 0) {
    return (
      <TabEmpty
        icon="ListMusic"
        sentence={t("gateway.engagement.rider.empty")}
        actionLabel={t("gateway.engagement.advanceAction")}
        href={tabHref(engagementKey, "engagement.advance")}
      />
    );
  }
  return (
    <div className="flex flex-col gap-16">
      {riders.data.map((r) => (
        <Section key={r.id ?? ""} id={`rider-${r.id}`} title={r.title ?? ""}>
          <RowList
            label={r.title ?? ""}
            items={lines.data
              .filter((l) => l.rider_id === r.id)
              .map((l) => ({
                id: l.id ?? "",
                title: l.description ?? "",
                meta: [
                  l.quantity ? t("gateway.engagement.rider.quantity", { n: l.quantity }) : null,
                ],
                tag: l.fulfilled_at
                  ? { label: t("gateway.engagement.rider.fulfilled"), tone: "success" as const }
                  : { label: t("gateway.engagement.rider.pending"), tone: "warning" as const },
              }))}
          />
        </Section>
      ))}
    </div>
  );
}

export async function SetTimesTab({ view, t, locale, engagementKey }: TabProps) {
  if (!hasArea(view, "operational")) {
    return (
      <TabEmpty
        icon="Lock"
        sentence={t("gateway.engagement.operationalClosed")}
        actionLabel={t("gateway.engagement.onboardingAction")}
        href={tabHref(engagementKey, "engagement.overview")}
      />
    );
  }
  const [cues, sheets] = await Promise.all([
    readView(view.ctx.db, "cues", { eq: { is_my_set: true }, order: ["planned_at", "asc"] }),
    readView(view.ctx.db, "day_sheets", {
      eq: { project_id: view.engagement.projectId },
      order: ["day", "asc"],
    }),
  ]);
  if (!cues.ok || !sheets.ok) return <RegionError />;
  if (cues.data.length === 0 && sheets.data.length === 0) {
    return (
      <TabEmpty
        icon="Clock"
        sentence={t("gateway.engagement.setTimes.empty")}
        actionLabel={t("gateway.engagement.messagesAction")}
        href={tabHref(engagementKey, "engagement.messages")}
      />
    );
  }
  return (
    <div className="flex flex-col gap-16">
      {cues.data.length > 0 ? (
        <RowList
          label={t("nav.gateway.engagementTabs.setTimes")}
          items={cues.data.map((c) => ({
            id: c.id ?? "",
            title: c.label ?? "",
            meta: [c.planned_at ? formatDateTime(locale, c.planned_at) : null, c.duration],
            ...(c.called_at
              ? {
                  tag: {
                    label: t("gateway.engagement.runOfShow.called", {
                      time: formatDateTime(locale, c.called_at),
                    }),
                    tone: "success" as const,
                  },
                }
              : {}),
          }))}
        />
      ) : null}
      {sheets.data.length > 0 ? (
        <Section title={t("gateway.engagement.setTimes.daySheets")}>
          <RowList
            label={t("gateway.engagement.setTimes.daySheets")}
            items={sheets.data.map((d) => ({
              id: d.id ?? "",
              title: d.day ? formatDate(locale, d.day) : "",
              detail: d.body ? (
                <p className="m-0 whitespace-pre-line text-text-13">{d.body}</p>
              ) : undefined,
            }))}
          />
        </Section>
      ) : null}
    </div>
  );
}

export async function HospitalityTab({ view, t, locale, engagementKey }: TabProps) {
  if (!hasArea(view, "operational")) {
    return (
      <TabEmpty
        icon="Lock"
        sentence={t("gateway.engagement.operationalClosed")}
        actionLabel={t("gateway.engagement.onboardingAction")}
        href={tabHref(engagementKey, "engagement.overview")}
      />
    );
  }
  const [hospitality, lodging] = await Promise.all([
    readView(view.ctx.db, "hospitality", {
      eq: { project_id: view.engagement.projectId },
      order: ["starts_at", "asc"],
    }),
    readView(view.ctx.db, "lodging", {
      eq: { project_id: view.engagement.projectId },
      order: ["check_in_on", "asc"],
    }),
  ]);
  if (!hospitality.ok || !lodging.ok) return <RegionError />;
  const rows = [
    ...lodging.data.map((l) => ({
      id: `lodging-${l.id}`,
      title: l.hotel_name ?? l.block_title ?? "",
      meta: [
        t(enumLabelKey("fulfillmentKind", "Lodging")),
        formatDateRange(locale, l.check_in_on, l.check_out_on),
        l.guest_name,
      ],
    })),
    ...hospitality.data.map((h) => ({
      id: h.id ?? "",
      title: h.title ?? h.description ?? "",
      meta: [
        h.fulfillment_kind ? t(enumLabelKey("fulfillmentKind", h.fulfillment_kind)) : null,
        h.starts_at ? formatDateTime(locale, h.starts_at) : null,
        h.supplier_name,
      ],
    })),
  ];
  if (rows.length === 0) {
    return (
      <TabEmpty
        icon="UtensilsCrossed"
        sentence={t("gateway.engagement.hospitality.empty")}
        actionLabel={t("gateway.engagement.advanceAction")}
        href={tabHref(engagementKey, "engagement.advance")}
      />
    );
  }
  return <RowList label={t("nav.gateway.engagementTabs.hospitality")} items={rows} />;
}

/**
 * Guest list. No guest-list table exists yet (A10 builds it in 0430 to 0439), so the tab says who
 * to ask and where guests are requested today: the advance packet.
 */
export function GuestListTab({ t, engagementKey }: TabProps) {
  return (
    <TabEmpty
      icon="Ticket"
      sentence={t("gateway.engagement.guestList.unavailable")}
      actionLabel={t("gateway.engagement.advanceAction")}
      href={tabHref(engagementKey, "engagement.advance")}
    />
  );
}

/** Settlement: the settlement documents of the engagement (A15 owns the settlement table). */
export function SettlementTab(props: TabProps) {
  return <DocumentsTab {...props} kinds={["Settlement"]} />;
}

/** The representative's roster (Section 4.4.2): represented artists and their engagements. */
export async function RosterTab({ view, t, locale }: TabProps) {
  const [representations, engagements] = await Promise.all([
    listRepresentations(view.ctx.db),
    listMyEngagements(view.ctx.db),
  ]);
  if (!representations.ok || !engagements.ok) return <RegionError />;
  const today = todayIso();
  const active = representations.data.filter((r) => r.artistPersonId !== view.ctx.personId);
  if (active.length === 0) {
    return (
      <TabEmpty
        icon="Users"
        sentence={t("gateway.engagement.roster.empty")}
        actionLabel={t("gateway.engagement.roster.action")}
        href="/settings/company/representation"
      />
    );
  }
  return (
    <div className="flex flex-col gap-16">
      {active.map((r) => {
        const standing = representationStanding(r, today);
        const theirs = engagements.data.filter((e) => e.personId === r.artistPersonId);
        return (
          <Section key={r.id} id={`artist-${r.id}`} title={r.artistName ?? ""}>
            <div className="flex flex-wrap items-center gap-8">
              <Tag
                tone={
                  standing === "active" ? "success" : standing === "pending" ? "warning" : "neutral"
                }
              >
                {t(`gateway.profile.representation.standing.${standing}`)}
              </Tag>
              <span className="text-text-13 text-text-secondary">
                {r.scopes.map((s) => t(enumLabelKey("representationScope", s))).join(", ")} ·{" "}
                {t("gateway.profile.representation.expires", {
                  date: formatDate(locale, r.expiresOn),
                })}
              </span>
            </div>
            {theirs.length > 0 ? (
              <RowList
                label={r.artistName ?? ""}
                items={theirs.map((e) => ({
                  id: e.id,
                  title: e.jobTitle,
                  meta: [e.orgName, formatDateRange(locale, e.startDate, e.endDate)],
                  tag: {
                    label: t(enumLabelKey("engagementState", e.state)),
                    tone: toneFor(e.state),
                  },
                  href: `/work/engagements/${e.key}/overview`,
                }))}
              />
            ) : (
              <p className="m-0 text-text-13 text-text-secondary">
                {t("gateway.engagement.roster.noEngagements")}
              </p>
            )}
          </Section>
        );
      })}
    </div>
  );
}
