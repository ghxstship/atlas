import type { AdvancingProject } from "@xos/data/advancing";
import { listAllocations, type Allocation } from "@xos/data/allocations";
import { listAccommodationBlocks, listFulfillments } from "@xos/data/hospitality";
import {
  listRosterTravelDayCounts,
  listRosterTravelParty,
  type TravelPartyMember,
} from "@xos/data/roster-facts";
import dynamic from "next/dynamic";
import { getFormatter } from "next-intl/server";
import { assignRoomAction, createTravelAction } from "@/app/[org]/hospitality/actions";
import { RefusalNotice } from "@/components/refusal-notice";
import { getTranslate } from "@/lib/shell/translate";
import { nodeHref } from "@/lib/shell/sitemap";
import type { AllocationRowProps } from "./allocation-dialogs";
import type { AdvancingContext } from "./context";
import { withQuery, type Search } from "./shared";
import { PageHeader } from "./ui";

// The table filters in the browser, and the prefilled hospitality forms open from its row actions; both load on demand.
const TravelPartyTable = dynamic(() =>
  import("./travel-party-table").then((m) => m.TravelPartyTable),
);
const FormDrawer = dynamic(() =>
  import("@/components/logistics-hospitality/forms").then((m) => m.FormDrawer),
);
// R7's Issue dialog, when an Approved allocation of the person waits to be issued (R5 correction 8, built by B5).
const TravelPartyIssue = dynamic(() =>
  import("./travel-party-issue").then((m) => m.TravelPartyIssue),
);

/** An Approved Lodging or Travel allocation of the entry not yet fully issued, which Issue hands over. */
export function issuableAllocation(
  allocations: readonly Allocation[],
  rosterEntryId: string,
  kind: "Lodging" | "Travel",
): Allocation | undefined {
  return allocations.find(
    (a) =>
      a.rosterEntryId === rosterEntryId &&
      a.kind === kind &&
      a.state === "Approved" &&
      a.issuedQuantity < a.quantity,
  );
}

function localIn(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(iso))
    .replace(" ", "T");
}

function issueRow(a: Allocation, item: string, holder: string): AllocationRowProps {
  return {
    id: a.id,
    kind: a.kind,
    quantity: a.quantity,
    issued: a.issuedQuantity,
    item: a.itemName ?? item,
    holder,
    window: "",
    offering: a.offering,
    rosterEntryId: a.rosterEntryId,
    engagementId: a.holderEngagementId,
    projectId: a.projectId,
    assetClassId: null,
    fromLocal: localIn(a.neededFrom, a.timeZone),
    toLocal: localIn(a.neededTo, a.timeZone),
    timeZone: a.timeZone,
  };
}

/** The status a chip shows for a person's room, pickup or pass. */
export type TravelChip = "missing" | "assigned" | "booked" | "issued" | "notNeeded" | "notVisible";

export function roomChip(m: TravelPartyMember): TravelChip {
  if (m.room.assigned) return "assigned";
  return m.travel?.needsLodging ? "missing" : "notNeeded";
}

export function pickupChip(m: TravelPartyMember): TravelChip {
  if (m.pickupBooked) return "booked";
  return m.travel?.needsGroundTransport ? "missing" : "notNeeded";
}

export function passChip(m: TravelPartyMember): TravelChip {
  if (m.passIssued === null) return "notVisible";
  return m.passIssued ? "issued" : "missing";
}

/**
 * Travel party (R5, G-175): everyone on a submitted, accepted or returned roster of the project whose travel is offered,
 * with their dates and airports and what hospitality has arranged (room, pickup, pass), and a strip of daily counts.
 * Values come only through app.roster_travel_party and app.roster_travel_day_counts, which log every read in the
 * person's access log; nothing here is exported. Assign room and Add pickup open R7's Issue dialog when the person has
 * an Approved Lodging or Travel allocation not yet issued, and otherwise the existing hospitality forms, prefilled and
 * unsaved; Add to a transfer books the pickup as a ground transfer (B5), hidden while a Travel allocation waits.
 */
export async function TravelParty({
  actx,
  project,
  path,
  search,
  title,
}: {
  actx: AdvancingContext;
  project: AdvancingProject;
  path: string;
  search: Search;
  title: string;
}) {
  const { ctx } = actx;
  const t = await getTranslate();
  const format = await getFormatter();
  const [party, counts, allocations] = await Promise.all([
    listRosterTravelParty(ctx.viewer.db, project.id),
    listRosterTravelDayCounts(ctx.viewer.db, project.id),
    listAllocations(ctx.viewer.db, { orgId: ctx.org.id, projectId: project.id }),
  ]);
  const approved = allocations.ok ? allocations.data : [];
  if (!party.ok || !counts.ok) {
    const refused = [party, counts].some(
      (r) => !r.ok && (r.error.kind === "refusal" || r.error.kind === "not-found"),
    );
    return (
      <div className="flex flex-col gap-12 min-w-0">
        <PageHeader title={title} />
        <RefusalNotice
          outcome="REFUSE"
          title={title}
          reason={
            refused
              ? t("workDetails.projectFacts.notReadable", {
                  kind: t("workDetails.projectFacts.kindsLower.travel"),
                  capability: "hospitality.fulfillment.read",
                })
              : t("advancing.travelParty.loadFailed")
          }
        />
      </div>
    );
  }
  const members = party.data;
  const day = (iso: string | null) =>
    iso
      ? format.dateTime(new Date(`${iso}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" })
      : "";
  const assignId = typeof search["assign"] === "string" ? search["assign"] : undefined;
  const pickupId = typeof search["pickup"] === "string" ? search["pickup"] : undefined;
  const assignFor = assignId ? members.find((m) => m.rosterEntryId === assignId) : undefined;
  const pickupFor = pickupId ? members.find((m) => m.rosterEntryId === pickupId) : undefined;
  const [blocks, fulfillments] = await Promise.all([
    assignFor
      ? listAccommodationBlocks(ctx.viewer.db, { orgId: ctx.org.id, projectId: project.id })
      : null,
    pickupFor
      ? listFulfillments(ctx.viewer.db, {
          orgId: ctx.org.id,
          projectId: project.id,
          kind: "Travel",
        })
      : null,
  ]);
  const closeHref = withQuery(path, search, { assign: null, pickup: null });
  const lodgingIssue = assignFor
    ? issuableAllocation(approved, assignFor.rosterEntryId, "Lodging")
    : undefined;
  const travelIssue = pickupFor
    ? issuableAllocation(approved, pickupFor.rosterEntryId, "Travel")
    : undefined;
  const inboundPlace = (m: TravelPartyMember) =>
    m.travel?.inboundAirportCode
      ? m.travel.inboundAirportName
        ? `${m.travel.inboundAirportName} (${m.travel.inboundAirportCode})`
        : m.travel.inboundAirportCode
      : "";
  const transfersBase = nodeHref("project.hospitality", {
    org: ctx.org.slug,
    projectKey: project.key,
  });
  const transferHref = (m: TravelPartyMember) =>
    transfersBase && !issuableAllocation(approved, m.rosterEntryId, "Travel")
      ? `${transfersBase}?${new URLSearchParams({
          section: "transfers",
          create: "1",
          passenger: m.personId,
          ...(m.travel?.inboundOn ? { pickupAt: `${m.travel.inboundOn}T12:00` } : {}),
          ...(inboundPlace(m) ? { pickupPlace: inboundPlace(m) } : {}),
        }).toString()}`
      : undefined;
  const truncated = counts.data.some((c) => c.truncated);
  return (
    <div className="flex flex-col gap-12 min-w-0">
      <PageHeader title={title} count={members.length} />
      <p className="m-0 text-text-13 text-text-secondary">{t("advancing.travelParty.sentence")}</p>
      {counts.data.length > 0 ? (
        <section
          aria-label={t("advancing.travelParty.counts.title")}
          className="flex flex-col gap-4"
        >
          <h2 className="m-0 text-label-14 font-semibold">
            {t("advancing.travelParty.counts.title")}
          </h2>
          <ol className="m-0 flex list-none gap-8 overflow-x-auto p-0">
            {counts.data.map((c) => (
              <li
                key={c.day}
                className="flex min-w-[9rem] flex-col gap-2 rounded-card border border-border-subtle px-12 py-8 text-text-12"
              >
                <span className="font-semibold text-text-13">{day(c.day)}</span>
                {(
                  [
                    ["arriving", c.arriving],
                    ["departing", c.departing],
                    ["onSite", c.onSite],
                    ["rooms", c.roomsNeeded],
                    ["pickups", c.pickupsNeeded],
                  ] as const
                ).map(([k, n]) => (
                  <span key={k} className="flex justify-between gap-8">
                    <span className="text-text-secondary">
                      {t(`advancing.travelParty.counts.${k}`)}
                    </span>
                    <span className="tabular-nums">{n}</span>
                  </span>
                ))}
              </li>
            ))}
          </ol>
          {truncated ? (
            <p className="m-0 text-text-12 text-text-secondary">
              {t("advancing.travelParty.counts.truncated")}
            </p>
          ) : null}
        </section>
      ) : null}
      {members.length === 0 ? (
        <p className="m-0 rounded-card border border-border-subtle p-16 text-text-13 text-text-secondary">
          {t("advancing.travelParty.empty")}
        </p>
      ) : (
        <TravelPartyTable
          caption={title}
          rows={members.map((m) => ({
            id: m.rosterEntryId,
            person: m.personName ?? "",
            party: m.partyName ?? "",
            role: m.roleCode ?? "",
            arrive: day(m.travel?.inboundOn ?? null),
            depart: day(m.travel?.outboundOn ?? null),
            airports: m.travel
              ? t("advancing.travelParty.airports", {
                  inbound: m.travel.inboundAirportCode ?? "",
                  outbound: m.travel.outboundAirportCode ?? "",
                })
              : "",
            travelMissing: m.travel === null,
            room: roomChip(m),
            pickup: pickupChip(m),
            pass: passChip(m),
            assignHref: withQuery(path, search, { assign: m.rosterEntryId, pickup: null }),
            pickupHref: withQuery(path, search, { pickup: m.rosterEntryId, assign: null }),
            ...(transferHref(m) ? { transferHref: transferHref(m) as string } : {}),
          }))}
        />
      )}
      {assignFor && lodgingIssue ? (
        <TravelPartyIssue
          org={ctx.org.slug}
          row={issueRow(
            lodgingIssue,
            t("advancing.travelParty.actions.assignRoom"),
            assignFor.personName ?? "",
          )}
          prefill={{
            ...(assignFor.travel?.inboundOn ? { checkIn: assignFor.travel.inboundOn } : {}),
            ...(assignFor.travel?.outboundOn ? { checkOut: assignFor.travel.outboundOn } : {}),
          }}
          closeHref={closeHref}
        />
      ) : assignFor && blocks ? (
        blocks.ok && blocks.data.length > 0 ? (
          <FormDrawer
            title={t("advancing.travelParty.actions.assignRoom")}
            closeHref={closeHref}
            hidden={{ org: ctx.org.slug, personId: assignFor.personId }}
            action={assignRoomAction}
            submitLabel={t("advancing.travelParty.actions.assignRoom")}
            fields={[
              {
                name: "blockId",
                label: t("hospitality.blocks.title"),
                kind: "select",
                required: true,
                defaultValue: blocks.data[0]?.id ?? "",
                options: blocks.data.map((b) => ({ value: b.id, label: `${b.key} ${b.title}` })),
              },
              {
                name: "checkInOn",
                label: t("hospitality.blocks.assignments.checkInOn"),
                kind: "date",
                required: true,
                defaultValue: assignFor.travel?.inboundOn ?? "",
              },
              {
                name: "checkOutOn",
                label: t("hospitality.blocks.assignments.checkOutOn"),
                kind: "date",
                required: true,
                defaultValue: assignFor.travel?.outboundOn ?? "",
              },
            ]}
          />
        ) : (
          <RefusalNotice
            outcome="NO_ANSWER"
            title={t("advancing.travelParty.actions.assignRoom")}
            reason={t("advancing.travelParty.noBlock")}
          />
        )
      ) : null}
      {pickupFor && travelIssue ? (
        <TravelPartyIssue
          org={ctx.org.slug}
          row={issueRow(
            travelIssue,
            t("advancing.travelParty.actions.addPickup"),
            pickupFor.personName ?? "",
          )}
          prefill={{
            ...(inboundPlace(pickupFor) ? { departsFrom: inboundPlace(pickupFor) } : {}),
            ...(pickupFor.travel?.inboundOn
              ? { departsAt: `${pickupFor.travel.inboundOn}T12:00` }
              : {}),
          }}
          closeHref={closeHref}
        />
      ) : pickupFor && fulfillments ? (
        fulfillments.ok && fulfillments.data.length > 0 ? (
          <FormDrawer
            title={t("advancing.travelParty.actions.addPickup")}
            closeHref={closeHref}
            hidden={{ org: ctx.org.slug, personId: pickupFor.personId, mode: "Ground" }}
            action={createTravelAction}
            submitLabel={t("advancing.travelParty.actions.addPickup")}
            fields={[
              {
                name: "fulfillmentId",
                label: t("hospitality.fulfillments.title"),
                kind: "select",
                required: true,
                defaultValue: fulfillments.data[0]?.id ?? "",
                options: fulfillments.data.map((f) => ({
                  value: f.id,
                  label: `${f.key} ${f.title}`,
                })),
              },
              {
                name: "departsFrom",
                label: t("hospitality.fulfillments.travel.departsFrom"),
                kind: "text",
                required: true,
                defaultValue: pickupFor.travel?.inboundAirportCode
                  ? pickupFor.travel.inboundAirportName
                    ? `${pickupFor.travel.inboundAirportName} (${pickupFor.travel.inboundAirportCode})`
                    : pickupFor.travel.inboundAirportCode
                  : "",
              },
              {
                name: "departsAt",
                label: t("hospitality.fulfillments.travel.departsAt"),
                kind: "datetime",
                required: true,
                help: t("logistics.common.timeZoneHelp", {
                  zone: fulfillments.data[0]?.timeZone ?? "UTC",
                }),
                defaultValue: pickupFor.travel?.inboundOn
                  ? `${pickupFor.travel.inboundOn}T12:00`
                  : "",
              },
              {
                name: "arrivesAtPlace",
                label: t("hospitality.fulfillments.travel.arrivesAtPlace"),
                kind: "text",
                required: true,
              },
            ]}
          />
        ) : (
          <RefusalNotice
            outcome="NO_ANSWER"
            title={t("advancing.travelParty.actions.addPickup")}
            reason={t("advancing.travelParty.noFulfillment")}
          />
        )
      ) : null}
    </div>
  );
}
