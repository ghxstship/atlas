import {
  hoursFromMinutes,
  listOnboardingItems,
  listSharedRecords,
  readView,
} from "@xos/data/gateway";
import { ActionButton } from "@/components/actions/action-button";
import { RegionError, Section } from "@/components/page/page";
import { acceptShiftAction, submitTimesheetAction } from "@/lib/actions/operations";
import { hasArea, tabHref } from "@/lib/engagement";
import { formatDate, formatDateRange, formatDateTime, formatMoney } from "@/lib/format";
import { enumLabelKey } from "@/lib/shell/translate";
import { toneFor } from "@/lib/states";
import { RowList, TabEmpty } from "./rows";
import type { TabProps } from "./tab-context";

/**
 * Crew and staff tabs (Section 4.4.4: shifts, timesheets, travel and lodging, credentials,
 * training and positions). Operational rows appear once the engagement is Active (Section 8.7).
 */

function NotOpen({ t, engagementKey }: Pick<TabProps, "t" | "engagementKey">) {
  return (
    <TabEmpty
      icon="Lock"
      sentence={t("gateway.engagement.operationalClosed")}
      actionLabel={t("gateway.engagement.onboardingAction")}
      href={tabHref(engagementKey, "engagement.overview")}
    />
  );
}

export async function ShiftsTab({ view, t, locale, engagementKey }: TabProps) {
  if (!hasArea(view, "operational")) return <NotOpen t={t} engagementKey={engagementKey} />;
  const shifts = await readView(view.ctx.db, "shifts", {
    eq: { engagement_id: view.engagement.id },
    order: ["starts_at", "asc"],
  });
  if (!shifts.ok) return <RegionError />;
  if (shifts.data.length === 0) {
    return (
      <TabEmpty
        icon="CalendarClock"
        sentence={t("gateway.engagement.shifts.empty")}
        actionLabel={t("gateway.engagement.messagesAction")}
        href={tabHref(engagementKey, "engagement.messages")}
      />
    );
  }
  return (
    <RowList
      label={t("nav.gateway.engagementTabs.shifts")}
      items={shifts.data.map((s) => ({
        id: s.id ?? "",
        title: s.job_title ?? s.scope_node_name ?? "",
        meta: [
          s.starts_at ? formatDateTime(locale, s.starts_at, s.time_zone) : null,
          s.ends_at ? formatDateTime(locale, s.ends_at, s.time_zone) : null,
          s.scope_node_name,
        ],
        ...(s.shift_state
          ? {
              tag: {
                label: t(enumLabelKey("shiftState", s.shift_state)),
                tone: toneFor(s.shift_state),
              },
            }
          : {}),
        ...(s.shift_state === "Published" && s.id
          ? {
              action: (
                <ActionButton
                  action={acceptShiftAction.bind(null, s.id)}
                  label={t("gateway.engagement.shifts.accept")}
                  variant="primary"
                />
              ),
            }
          : {}),
      }))}
    />
  );
}

/** Staff positions: the shifts of the engagement grouped by the position (scope node) they fill. */
export async function PositionsTab({ view, t, locale, engagementKey }: TabProps) {
  if (!hasArea(view, "operational")) return <NotOpen t={t} engagementKey={engagementKey} />;
  const shifts = await readView(view.ctx.db, "shifts", {
    eq: { engagement_id: view.engagement.id },
    order: ["starts_at", "asc"],
  });
  if (!shifts.ok) return <RegionError />;
  const groups = new Map<string, typeof shifts.data>();
  for (const s of shifts.data) {
    const key = s.scope_node_name ?? s.job_title ?? "";
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  if (groups.size === 0) {
    return (
      <TabEmpty
        icon="Users"
        sentence={t("gateway.engagement.positions.empty")}
        actionLabel={t("gateway.engagement.trainingAction")}
        href={tabHref(engagementKey, "engagement.training")}
      />
    );
  }
  return (
    <div className="flex flex-col gap-16">
      {[...groups].map(([position, list]) => (
        <Section key={position} id={`position-${position}`} title={position}>
          <RowList
            label={position}
            items={list.map((s) => ({
              id: s.id ?? "",
              title: s.starts_at ? formatDateTime(locale, s.starts_at, s.time_zone) : position,
              meta: [
                s.project_name,
                s.ends_at ? formatDateTime(locale, s.ends_at, s.time_zone) : null,
              ],
              ...(s.shift_state
                ? {
                    tag: {
                      label: t(enumLabelKey("shiftState", s.shift_state)),
                      tone: toneFor(s.shift_state),
                    },
                  }
                : {}),
            }))}
          />
        </Section>
      ))}
    </div>
  );
}

export async function TimesheetsTab({ view, t, locale, engagementKey }: TabProps) {
  if (!hasArea(view, "operational") && !hasArea(view, "money"))
    return <NotOpen t={t} engagementKey={engagementKey} />;
  const [sheets, entries] = await Promise.all([
    readView(view.ctx.db, "timesheets", {
      eq: { engagement_id: view.engagement.id },
      order: ["period_start", "desc"],
    }),
    readView(view.ctx.db, "time_entries", {
      eq: { engagement_id: view.engagement.id },
      order: ["clock_in", "desc"],
    }),
  ]);
  if (!sheets.ok || !entries.ok) return <RegionError />;
  return (
    <div className="flex flex-col gap-16">
      {sheets.data.length === 0 ? (
        <TabEmpty
          icon="Clock"
          sentence={t("gateway.engagement.timesheets.empty")}
          actionLabel={t("gateway.engagement.shiftsAction")}
          href={tabHref(
            engagementKey,
            view.tabs.includes("engagement.shifts") ? "engagement.shifts" : "engagement.overview",
          )}
        />
      ) : (
        <RowList
          label={t("nav.gateway.engagementTabs.timesheets")}
          items={sheets.data.map((s) => ({
            id: s.id ?? "",
            title: formatDateRange(locale, s.period_start, s.period_end),
            meta: [
              t("gateway.engagement.timesheets.hours", {
                n: hoursFromMinutes(s.worked_minutes) ?? 0,
              }),
              s.submitted_at
                ? t("gateway.engagement.timesheets.submitted", {
                    date: formatDate(locale, s.submitted_at),
                  })
                : null,
            ],
            ...(s.timesheet_state
              ? {
                  tag: {
                    label: t(enumLabelKey("timesheetState", s.timesheet_state)),
                    tone: toneFor(s.timesheet_state),
                  },
                }
              : {}),
            ...((s.timesheet_state === "Proposed" || s.timesheet_state === "Rejected") && s.id
              ? {
                  action: (
                    <ActionButton
                      action={submitTimesheetAction.bind(null, s.id)}
                      label={t("gateway.engagement.timesheets.submit")}
                      variant="primary"
                    />
                  ),
                }
              : {}),
          }))}
        />
      )}
      {entries.data.length > 0 ? (
        <Section title={t("gateway.engagement.timesheets.entries")}>
          <TimeEntryList entries={entries.data} t={t} locale={locale} />
        </Section>
      ) : null}
    </div>
  );
}

function TimeEntryList({
  entries,
  t,
  locale,
}: {
  entries: readonly {
    id: string | null;
    clock_in: string | null;
    clock_out: string | null;
    break_minutes: number | null;
    source: string | null;
  }[];
  t: TabProps["t"];
  locale: string;
}) {
  return (
    <RowList
      label={t("gateway.engagement.timesheets.entries")}
      items={entries.map((e) => ({
        id: e.id ?? "",
        title: e.clock_in ? formatDateTime(locale, e.clock_in) : "",
        meta: [
          e.clock_out
            ? t("gateway.engagement.time.out", { time: formatDateTime(locale, e.clock_out) })
            : t("gateway.engagement.time.open"),
          e.break_minutes ? t("gateway.engagement.time.break", { n: e.break_minutes }) : null,
          e.source ? t(enumLabelKey("timeEntrySource", e.source)) : null,
        ],
      }))}
    />
  );
}

/** Contractor time where hourly (Section 4.4.4): the time entries of the engagement. */
export async function TimeTab({ view, t, locale, engagementKey }: TabProps) {
  if (!hasArea(view, "operational")) return <NotOpen t={t} engagementKey={engagementKey} />;
  const entries = await readView(view.ctx.db, "time_entries", {
    eq: { engagement_id: view.engagement.id },
    order: ["clock_in", "desc"],
  });
  if (!entries.ok) return <RegionError />;
  if (entries.data.length === 0) {
    return (
      <TabEmpty
        icon="Clock"
        sentence={t("gateway.engagement.time.empty")}
        actionLabel={t("gateway.engagement.invoicesAction")}
        href={tabHref(engagementKey, "engagement.invoices")}
      />
    );
  }
  return <TimeEntryList entries={entries.data} t={t} locale={locale} />;
}

export async function TravelTab({ view, t, locale, engagementKey }: TabProps) {
  if (!hasArea(view, "operational")) return <NotOpen t={t} engagementKey={engagementKey} />;
  const [lodging, segments, travel] = await Promise.all([
    readView(view.ctx.db, "lodging", {
      eq: { project_id: view.engagement.projectId },
      order: ["check_in_on", "asc"],
    }),
    readView(view.ctx.db, "travel", {
      eq: { engagement_id: view.engagement.id },
      order: ["departs_at", "asc"],
    }),
    readView(view.ctx.db, "hospitality", {
      eq: { project_id: view.engagement.projectId, fulfillment_kind: "Travel" },
      order: ["starts_at", "asc"],
    }),
  ]);
  if (!lodging.ok || !segments.ok || !travel.ok) return <RegionError />;
  if (lodging.data.length === 0 && segments.data.length === 0 && travel.data.length === 0) {
    return (
      <TabEmpty
        icon="BedDouble"
        sentence={t("gateway.engagement.travel.empty")}
        actionLabel={t("gateway.engagement.messagesAction")}
        href={tabHref(engagementKey, "engagement.messages")}
      />
    );
  }
  return (
    <div className="flex flex-col gap-16">
      {segments.data.length > 0 ? (
        <Section title={t("gateway.engagement.travel.itinerary")}>
          <RowList
            label={t("gateway.engagement.travel.itinerary")}
            items={segments.data.map((s) => ({
              id: s.id ?? "",
              title: t("gateway.engagement.travel.route", {
                from: s.departs_from ?? "",
                to: s.arrives_at_place ?? "",
              }),
              meta: [
                [s.operator_name, s.service_identifier].filter(Boolean).join(" "),
                s.departs_at
                  ? t("gateway.engagement.travel.departs", {
                      time: formatDateTime(locale, s.departs_at, s.departs_time_zone),
                    })
                  : null,
                s.arrives_at
                  ? t("gateway.engagement.travel.arrives", {
                      time: formatDateTime(locale, s.arrives_at, s.arrives_time_zone),
                    })
                  : null,
                s.confirmation_identifier
                  ? t("gateway.engagement.travel.confirmation", {
                      code: s.confirmation_identifier,
                    })
                  : null,
              ],
              ...(s.travel_mode
                ? {
                    tag: {
                      label: t(enumLabelKey("travelMode", s.travel_mode)),
                      tone: "neutral" as const,
                    },
                  }
                : {}),
            }))}
          />
        </Section>
      ) : null}
      {lodging.data.length > 0 ? (
        <Section title={t("gateway.engagement.travel.lodging")}>
          <RowList
            label={t("gateway.engagement.travel.lodging")}
            items={lodging.data.map((l) => ({
              id: l.id ?? "",
              title: l.hotel_name ?? l.block_title ?? "",
              meta: [formatDateRange(locale, l.check_in_on, l.check_out_on), l.guest_name],
            }))}
          />
        </Section>
      ) : null}
      {travel.data.length > 0 ? (
        <Section title={t("gateway.engagement.travel.travel")}>
          <RowList
            label={t("gateway.engagement.travel.travel")}
            items={travel.data.map((h) => ({
              id: h.id ?? "",
              title: h.title ?? h.description ?? "",
              meta: [h.starts_at ? formatDateTime(locale, h.starts_at) : null, h.supplier_name],
            }))}
          />
        </Section>
      ) : null}
    </div>
  );
}

/** Per diem: the allowances paid through the engagement (A13 0981), then listed amenities. */
export async function PerDiemTab({ view, t, locale, engagementKey }: TabProps) {
  if (!hasArea(view, "operational")) return <NotOpen t={t} engagementKey={engagementKey} />;
  const [allowances, amenities] = await Promise.all([
    readView(view.ctx.db, "per_diems", {
      eq: { engagement_id: view.engagement.id },
      order: ["day", "asc"],
    }),
    readView(view.ctx.db, "hospitality", {
      eq: { project_id: view.engagement.projectId, fulfillment_kind: "Amenity" },
      order: ["starts_at", "asc"],
    }),
  ]);
  if (!allowances.ok || !amenities.ok) return <RegionError />;
  if (allowances.data.length === 0 && amenities.data.length === 0) {
    return (
      <TabEmpty
        icon="Wallet"
        sentence={t("gateway.engagement.perDiem.empty")}
        actionLabel={t("gateway.engagement.invoicesAction")}
        href={tabHref(
          engagementKey,
          view.tabs.includes("engagement.timesheets")
            ? "engagement.timesheets"
            : "engagement.overview",
        )}
      />
    );
  }
  const totals = new Map<string, number>();
  for (const a of allowances.data) {
    if (a.currency_code && a.amount_minor !== null)
      totals.set(a.currency_code, (totals.get(a.currency_code) ?? 0) + a.amount_minor);
  }
  return (
    <div className="flex flex-col gap-16">
      {allowances.data.length > 0 ? (
        <Section title={t("gateway.engagement.perDiem.allowances")}>
          <RowList
            label={t("gateway.engagement.perDiem.allowances")}
            items={allowances.data.map((a) => ({
              id: a.id ?? "",
              title: a.day ? formatDate(locale, a.day) : "",
              meta: [formatMoney(locale, a.amount_minor, a.currency_code), a.project_name],
            }))}
          />
          <p className="m-0 text-text-14 font-medium">
            {t("gateway.engagement.perDiem.total", {
              amount: [...totals]
                .map(([currency, minor]) => formatMoney(locale, minor, currency))
                .join(", "),
            })}
          </p>
        </Section>
      ) : null}
      {amenities.data.length > 0 ? (
        <Section title={t("gateway.engagement.perDiem.amenities")}>
          <RowList
            label={t("gateway.engagement.perDiem.amenities")}
            items={amenities.data.map((h) => ({
              id: h.id ?? "",
              title: h.title ?? h.description ?? "",
              meta: [
                formatDateRange(locale, h.starts_at, h.ends_at),
                h.quantity ? t("gateway.engagement.perDiem.quantity", { n: h.quantity }) : null,
              ],
            }))}
          />
        </Section>
      ) : null}
    </div>
  );
}

export async function CredentialsTab({ view, t, locale, engagementKey }: TabProps) {
  const credentials = await readView(view.ctx.db, "credentials", {
    eq: { engagement_id: view.engagement.id },
  });
  if (!credentials.ok) return <RegionError />;
  if (credentials.data.length === 0) {
    return (
      <TabEmpty
        icon="IdCard"
        sentence={t("gateway.engagement.credentials.empty")}
        actionLabel={t("gateway.engagement.onboardingAction")}
        href={tabHref(
          engagementKey,
          view.tabs.includes("engagement.onboarding")
            ? "engagement.onboarding"
            : "engagement.overview",
        )}
      />
    );
  }
  return (
    <RowList
      label={t("nav.gateway.engagementTabs.credentials")}
      items={credentials.data.map((c) => ({
        id: c.id ?? "",
        title: c.category_name ?? c.category_code ?? "",
        meta: [
          c.credential_number,
          c.holder_name,
          formatDateRange(locale, c.valid_from, c.valid_to),
        ],
        tag: c.revoked_at
          ? { label: t("gateway.engagement.credentials.revoked"), tone: "danger" as const }
          : { label: t("gateway.engagement.credentials.valid"), tone: "success" as const },
      }))}
    />
  );
}

/** Training and briefing acknowledgments (Section 4.4.4 Staff) plus shared training sessions. */
export async function TrainingTab({ view, t, locale, engagementKey }: TabProps) {
  const [items, sessions] = await Promise.all([
    listOnboardingItems(view.ctx.db, view.engagement.id),
    hasArea(view, "operational")
      ? listSharedRecords(view.ctx.db, {
          projectIds: [view.engagement.projectId],
          kinds: ["Training"],
        })
      : null,
  ]);
  if (!items.ok || (sessions && !sessions.ok)) return <RegionError />;
  const training = items.data.filter((i) => i.kind === "Training" || i.kind === "Acknowledgment");
  const shared = sessions?.ok ? sessions.data : [];
  if (training.length === 0 && shared.length === 0) {
    return (
      <TabEmpty
        icon="GraduationCap"
        sentence={t("gateway.engagement.training.empty")}
        actionLabel={t("gateway.engagement.onboardingAction")}
        href={tabHref(engagementKey, "engagement.onboarding")}
      />
    );
  }
  return (
    <div className="flex flex-col gap-16">
      {training.length > 0 ? (
        <RowList
          label={t("nav.gateway.engagementTabs.training")}
          items={training.map((i) => ({
            id: i.id,
            title: i.name,
            meta: [t(enumLabelKey("onboardingItemKind", i.kind))],
            tag: i.satisfied
              ? {
                  label: t("gateway.engagement.onboarding.standing.verified"),
                  tone: "success" as const,
                }
              : {
                  label: t("gateway.engagement.onboarding.standing.todo"),
                  tone: "warning" as const,
                },
            ...(!i.satisfied ? { href: tabHref(engagementKey, "engagement.onboarding") } : {}),
          }))}
        />
      ) : null}
      {shared.length > 0 ? (
        <Section title={t("gateway.engagement.training.sessions")}>
          <RowList
            label={t("gateway.engagement.training.sessions")}
            items={shared.map((r) => ({
              id: r.id,
              title: r.title,
              meta: [r.startsAt ? formatDateTime(locale, r.startsAt, r.timeZone) : null],
              tag: { label: t(enumLabelKey("recordState", r.state)), tone: toneFor(r.state) },
            }))}
          />
        </Section>
      ) : null}
    </div>
  );
}
