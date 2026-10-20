import {
  listMyEngagements,
  listRepresentations,
  readView,
  representationStanding,
} from "@xos/data/gateway";
import { RegionError, Section } from "@/components/page/page";
import { Tag } from "@/components/ui";
import { hasArea, tabHref } from "@/lib/engagement";
import { formatDate, formatDateRange, formatDateTime, formatMoney, todayIso } from "@/lib/format";
import { listEngagedGuests, type GuestEntryState } from "@/lib/party";
import { enumLabelKey } from "@/lib/shell/translate";
import { toneFor, type Tone } from "@/lib/states";
import { AreaClosed, RowList, TabEmpty } from "./rows";
import { GuestRequestForm, SettlementResponseForm } from "./party-forms";
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
    return <AreaClosed view={view} t={t} engagementKey={engagementKey} />;
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
    return <AreaClosed view={view} t={t} engagementKey={engagementKey} />;
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
 * Guest list (A10 0965): the engagement's guests with plus-ones and their state, and the request
 * form while the operational area is open. The production approves or declines in Atlas.
 */
export async function GuestListTab({ view, t, locale, engagementKey }: TabProps) {
  if (!hasArea(view, "operational")) {
    return <AreaClosed view={view} t={t} engagementKey={engagementKey} />;
  }
  const guests = await listEngagedGuests(view.ctx.db, view.engagement.id);
  if (!guests.ok) return <RegionError />;
  const form = <GuestRequestForm engagementId={view.engagement.id} />;
  if (guests.data.length === 0) {
    return (
      <div className="flex flex-col gap-16">
        <p className="m-0 text-text-14 text-text-secondary">
          {t("gateway.engagement.guestList.empty")}
        </p>
        <Section title={t("gateway.engagement.guestList.request")}>{form}</Section>
      </div>
    );
  }
  const total = guests.data.reduce((n, g) => n + 1 + g.plusOnes, 0);
  return (
    <div className="flex flex-col gap-16">
      <RowList
        label={t("gateway.engagement.guestList.listLabel", { n: total })}
        items={guests.data.map((g) => ({
          id: g.id,
          title: g.guestName,
          meta: [
            g.plusOnes > 0 ? t("gateway.engagement.guestList.plusOnes", { n: g.plusOnes }) : null,
            g.checkedInAt
              ? t("gateway.engagement.guestList.checkedIn", {
                  time: formatDateTime(locale, g.checkedInAt),
                })
              : null,
            g.note,
          ],
          tag: {
            label: t(enumLabelKey("guestEntryState", g.state)),
            tone: guestTone(g.state),
          },
        }))}
      />
      <Section title={t("gateway.engagement.guestList.request")}>{form}</Section>
    </div>
  );
}

function guestTone(state: GuestEntryState): Tone {
  if (state === "Declined") return "danger";
  if (state === "Requested") return "warning";
  return "success";
}

/**
 * Settlement (A15 0991): each settlement once submitted, its lines and the NULL-aware net, with the
 * accept or dispute form while it waits on the party; then the engagement's settlement documents.
 */
export async function SettlementTab(props: TabProps) {
  const { view, t, locale } = props;
  const settlements = await readView(view.ctx.db, "settlements", {
    eq: { engagement_id: view.engagement.id },
    order: ["submitted_at", "desc"],
  });
  if (!settlements.ok) return <RegionError />;
  const ids = settlements.data.flatMap((s) => (s.id ? [s.id] : []));
  const lines = await readView(view.ctx.db, "settlement_lines", {
    in: ["settlement_id", ids],
    order: ["line_number", "asc"],
  });
  if (!lines.ok) return <RegionError />;
  return (
    <div className="flex flex-col gap-16">
      {settlements.data.map((s) => {
        const currency = s.currency_code ?? "";
        const net = formatMoney(locale, s.net_minor, currency);
        return (
          <Section key={s.id ?? ""} id={`settlement-${s.id}`} title={s.title ?? ""}>
            <div className="flex flex-wrap items-center gap-8">
              {s.settlement_state ? (
                <Tag tone={toneFor(s.settlement_state)}>
                  {t(enumLabelKey("settlementState", s.settlement_state))}
                </Tag>
              ) : null}
              <span className="text-text-13 text-text-secondary">
                {[
                  s.project_name,
                  s.settled_on ? formatDate(locale, s.settled_on) : null,
                  s.submitted_at
                    ? t("gateway.engagement.settlement.submitted", {
                        date: formatDate(locale, s.submitted_at),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <RowList
              label={t("gateway.engagement.settlement.lines", { title: s.title ?? "" })}
              items={lines.data
                .filter((l) => l.settlement_id === s.id)
                .map((l) => {
                  const amount = formatMoney(locale, l.amount_minor, currency);
                  const subtracts = l.line_kind === "Deduction" || l.line_kind === "Withholding";
                  return {
                    id: l.id ?? "",
                    title: l.description ?? "",
                    meta: [
                      l.line_kind ? t(enumLabelKey("settlementLineKind", l.line_kind)) : null,
                      amount === null
                        ? t("gateway.engagement.settlement.unpriced")
                        : subtracts
                          ? t("gateway.engagement.settlement.less", { amount })
                          : amount,
                    ],
                  };
                })}
            />
            <p className="m-0 text-text-14 font-medium">
              {net === null
                ? t("gateway.engagement.settlement.netUnpriced")
                : t("gateway.engagement.settlement.net", { amount: net })}
            </p>
            {s.settlement_state === "Submitted" && s.id ? (
              <SettlementResponseForm settlementId={s.id} title={s.title ?? ""} />
            ) : null}
          </Section>
        );
      })}
      {settlements.data.length === 0 ? (
        <p className="m-0 text-text-14 text-text-secondary">
          {t("gateway.engagement.settlement.none")}
        </p>
      ) : null}
      <DocumentsTab {...props} kinds={["Settlement"]} />
    </div>
  );
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
