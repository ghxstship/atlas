import { listMyRosterEntries } from "@xos/data/roster";
import {
  listMyAllocations,
  listMyParkingPasses,
  type EngagedAllocation,
} from "@xos/data/gateway-allocations";
import { readView } from "@xos/data/gateway";
import type { Route } from "next";
import Link from "next/link";
import { RegionError, Section } from "@/components/page/page";
import { UpNextActions } from "@/components/page/up-next-actions";
import { Card, PropertyList } from "@/components/ui";
import { tabHref } from "@/lib/engagement";
import { enumLabelKey } from "@/lib/shell/translate";
import { formatCountdown, formatDate, formatDateTime } from "@/lib/format";
import { assignedToYou, parkingLines, rosterBring, rosterCall } from "@/lib/roster-member";
import { allocationTag, allocationTitle } from "./crew-allocations";
import { RowList, TabEmpty } from "./rows";
import type { TabProps } from "./tab-context";

/**
 * A person on a party's roster (R8, ADR 0100 roster-member): the Overview is their own Up Next card (when
 * to arrive, the call time, where, parking, whom to ask, what to bring and pick up) and what is
 * assigned to them, with the computed status of each (owner decision 8). They never see a colleague's
 * rows or the party's pool. Documents are their own documents and certifications.
 */

/** The Assigned to you list: the person's own allocations on their entries, with status tags. */
export function AssignedToYou({
  allocations,
  t,
  locale,
}: {
  allocations: readonly EngagedAllocation[];
  t: TabProps["t"];
  locale: string;
}) {
  return (
    <Section title={t("gateway.engagement.rosterMember.assigned")}>
      {allocations.length === 0 ? (
        <p className="m-0 text-text-14 text-text-secondary">
          {t("gateway.engagement.rosterMember.assignedEmpty")}
        </p>
      ) : (
        <RowList
          label={t("gateway.engagement.rosterMember.assigned")}
          items={allocations.map((a) => ({
            id: a.id,
            title: t("gateway.engagement.crew.items.line", {
              n: a.quantity,
              item: allocationTitle(a, t),
            }),
            meta: [formatDateTime(locale, a.neededFrom, a.neededTimeZone)],
            tag: allocationTag(a, t),
          }))}
        />
      )}
    </Section>
  );
}

/**
 * Assigned to you on any engagement where the viewer holds their own roster entry: a roster member's,
 * and the self entry of a person engaged on their own. Nothing renders without an entry.
 */
export async function AssignedToYouSection({ view, t, locale }: Omit<TabProps, "engagementKey">) {
  const entries = await listMyRosterEntries(view.ctx.db);
  if (!entries.ok) return null;
  const ids = entries.data.filter((e) => e.engagementId === view.engagement.id).map((e) => e.id);
  if (ids.length === 0) return null;
  const allocations = await listMyAllocations(view.ctx.db, ids);
  if (!allocations.ok) return <RegionError />;
  return <AssignedToYou allocations={assignedToYou(allocations.data, ids)} t={t} locale={locale} />;
}

export async function RosterMemberOverview({ view, t, locale, engagementKey }: TabProps) {
  const e = view.engagement;
  const roster = view.rosterEngagement;
  const entryId = view.rosterEntryId;
  if (!roster || !entryId) return <RegionError />;
  const [allocations, passes, upNext] = await Promise.all([
    listMyAllocations(view.ctx.db, [entryId]),
    listMyParkingPasses(view.ctx.db, e.projectId),
    readView(view.ctx.db, "engagement_up_next", { eq: { engagement_id: e.id } }),
  ]);
  if (!allocations.ok || !passes.ok) return <RegionError />;
  const mine = assignedToYou(allocations.data, [entryId]);
  const call = rosterCall({ engagement: roster, shifts: [], today: view.today });
  const venue = upNext.ok ? upNext.data[0] : undefined;
  const where = venue
    ? [venue.venue_name, venue.venue_street_address, venue.venue_locality, venue.venue_postal_code]
        .map((v) => v?.trim() ?? "")
        .filter((v) => v !== "")
        .join(", ")
    : "";
  const parking = parkingLines(passes.data);
  const bring = rosterBring(mine);
  const when =
    roster.arrivalStartsAt && roster.arrivalEndsAt
      ? t("gateway.engagement.rosterMember.window", {
          start: formatDateTime(locale, roster.arrivalStartsAt, e.projectTimeZone),
          end: formatDateTime(locale, roster.arrivalEndsAt, e.projectTimeZone),
        })
      : t("gateway.engagement.rosterMember.noArrival");
  const details = view.tabs.includes("engagement.project-details");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_var(--layout-property-column)] gap-24 max-lg:grid-cols-[minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-16">
        <p className="m-0 max-w-[60ch] text-text-14 text-text-secondary">
          {t("gateway.engagement.rosterMember.sentence", {
            org: e.orgName,
            project: e.projectName,
          })}
        </p>
        <Section title={t("gateway.engagement.rosterMember.upNext")}>
          <Card
            title={e.projectName}
            {...(call
              ? {
                  meta: (
                    <span className="font-semibold text-accent-text">
                      {formatCountdown(locale, call.at)}
                    </span>
                  ),
                }
              : {})}
            footer={
              <UpNextActions
                title={e.projectName}
                startsAt={roster.arrivalStartsAt}
                endsAt={roster.arrivalEndsAt}
                location={where || null}
                openHref={tabHref(engagementKey, "engagement.messages")}
                labels={{
                  open: t("gateway.engagement.rosterMember.message"),
                  calendar: t("gateway.home.upNext.calendar"),
                }}
              />
            }
          >
            <PropertyList
              items={[
                { label: t("gateway.engagement.rosterMember.when"), value: when },
                ...(call
                  ? [
                      {
                        label: t("gateway.engagement.rosterMember.call"),
                        value: formatDateTime(locale, call.at, call.timeZone),
                      },
                    ]
                  : []),
                ...(where
                  ? [{ label: t("gateway.engagement.rosterMember.where"), value: where }]
                  : []),
                ...(parking.length > 0
                  ? [
                      {
                        label: t("gateway.engagement.rosterMember.parking"),
                        value: parking.join("; "),
                      },
                    ]
                  : []),
                {
                  label: t("gateway.engagement.rosterMember.contact"),
                  value: roster.leadName ?? e.orgName,
                },
                ...(bring.length > 0
                  ? [
                      {
                        label: t("gateway.engagement.rosterMember.bring"),
                        value: (
                          <ul className="m-0 flex list-none flex-col gap-2 p-0">
                            {bring.map((b) => (
                              <li key={b}>{b}</li>
                            ))}
                          </ul>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </Card>
        </Section>
        <AssignedToYou allocations={mine} t={t} locale={locale} />
        {details ? (
          <Link
            href={tabHref(engagementKey, "engagement.project-details") as Route}
            className="text-text-14 text-accent-text underline"
          >
            {t("gateway.engagement.rosterMember.projectDetails")}
          </Link>
        ) : null}
      </div>
      <aside>
        <Card>
          <PropertyList
            items={[
              { label: t("gateway.work.engagements.org"), value: e.orgName },
              { label: t("gateway.work.engagements.project"), value: e.projectName },
              {
                label: t("gateway.engagement.rosterMember.party"),
                value: t(enumLabelKey("externalRoleType", e.roleType)),
              },
              {
                label: t("gateway.work.engagements.dates"),
                value: formatDate(locale, e.startDate),
              },
            ]}
          />
        </Card>
      </aside>
    </div>
  );
}

/** The person's own documents and certifications (api_external.my_profile_documents, 2080). */
export async function RosterMemberDocuments({ view, t, locale, engagementKey }: TabProps) {
  const docs = await readView(view.ctx.db, "my_profile_documents", { order: ["title", "asc"] });
  if (!docs.ok) return <RegionError />;
  if (docs.data.length === 0) {
    return (
      <TabEmpty
        icon="FileText"
        sentence={t("gateway.engagement.rosterMember.documentsEmpty")}
        actionLabel={t("gateway.engagement.messagesAction")}
        href={tabHref(engagementKey, "engagement.messages")}
      />
    );
  }
  return (
    <RowList
      label={t("nav.gateway.engagementTabs.documents")}
      items={docs.data.map((d) => ({
        id: d.id ?? "",
        title: d.title ?? "",
        meta: [
          d.org_name,
          d.project_name,
          d.expires_on
            ? t("gateway.engagement.documents.expires", { date: formatDate(locale, d.expires_on) })
            : null,
        ],
      }))}
    />
  );
}
