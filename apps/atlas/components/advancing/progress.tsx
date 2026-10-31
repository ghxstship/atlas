import {
  listAdvanceProgress,
  listAllocationHeat,
  listRosterReadiness,
  listTrackProgress,
  READINESS_CATEGORIES,
  TRACK_STATES,
  ADVANCE_TRACKS,
  type AdvanceCellState,
  type AllocationHeatCell,
  type ReadinessState,
  type TrackState,
} from "@xos/data/advancing";
import type { RecordState, StatusHeatmapCell, StatusHeatmapLegendItem } from "@xos/ui";
import { getFormatter } from "next-intl/server";
import type { ReactNode } from "react";
import { LiveList } from "@/components/live/live-list";
import { getTranslate } from "@/lib/shell/translate";
import type { AdvancingContext } from "./context";
import {
  LinkedHeatmap,
  PacketsHeatmap,
  ProgressPaneTabs,
  TracksHeatmap,
  type HeatmapData,
  type TrackCellAction,
} from "./progress-panes";
import type { Search } from "./shared";
import { PageHeader, StatTile } from "./ui";
import { SelectFilter } from "./views";
import { CollectionPage } from "@/components/platform/collection-page";

const PANES = ["packets", "crew", "allocations", "tracks"] as const;

/** The catalog segment of a stored value: Awaiting Review is awaitingReview, Ready for Sign-off readyForSignOff. */
function key(value: string): string {
  return value
    .replace(/-/g, " ")
    .split(" ")
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

const CELL_ICON: Readonly<Record<AdvanceCellState, RecordState>> = {
  Missing: "proposed",
  "Awaiting Review": "in-review",
  Accepted: "complete",
  Returned: "blocked",
  Complete: "complete",
  "Not Applicable": "canceled",
};

const READINESS_ICON: Readonly<Record<ReadinessState, RecordState>> = {
  Accepted: "complete",
  "Awaiting Person": "scheduled",
  Declined: "canceled",
  "On File": "complete",
  Missing: "proposed",
  "Not Shared": "blocked",
  Shared: "complete",
  Submitted: "complete",
  "Not Offered": "canceled",
  Hidden: "deferred",
};

const ALLOCATION_STATES = ["Requested", "Approved", "Partly Issued", "Issued", "Returned"] as const;
type AllocationState = (typeof ALLOCATION_STATES)[number];
const ALLOCATION_ICON: Readonly<Record<AllocationState, RecordState>> = {
  Requested: "in-review",
  Approved: "ready",
  "Partly Issued": "active",
  Issued: "complete",
  Returned: "deferred",
};

const TRACK_ICON: Readonly<Record<TrackState, RecordState>> = {
  "Not Started": "proposed",
  "In Progress": "active",
  "Ready for Sign-off": "ready",
  "Signed Off": "complete",
  Reopened: "blocked",
};

/** Where one party's allocations of one offering stand, from R7's computed quantities. */
function allocationState(c: AllocationHeatCell): AllocationState | null {
  if (c.requested > 0) return "Requested";
  if (c.issued > 0 && c.returned + c.lost >= c.issued) return "Returned";
  if (c.approved > 0 && c.issued >= c.approved) return "Issued";
  if (c.issued > 0) return "Partly Issued";
  if (c.approved > 0) return "Approved";
  return null;
}

/**
 * Advancing > Progress (R11, Section 11.11): every outstanding advancing item of a project on one screen. Tiles count
 * what is outstanding, overdue, awaiting review, missing on rosters and ready to sign off; panes cross recipients with
 * sections (one packet at a time, with a bulk reminder), people with readiness categories, parties with offerings,
 * and recipients with tracks (sign-off and revoke). Everything is computed in the database (2740 and 2743) and the
 * page rereads as answers and roster entries change (A123's LiveList).
 */
export async function AdvancingProgress({
  actx,
  path,
  search,
  title,
}: {
  actx: AdvancingContext;
  path: string;
  search: Search;
  title: string;
}) {
  const { ctx, can, project } = actx;
  const t = await getTranslate();
  const format = await getFormatter();
  if (!project) return null;
  const db = ctx.viewer.db;
  const pane = PANES.find((p) => p === search["pane"]) ?? "packets";
  const [progress, tracks, readiness, heat] = await Promise.all([
    listAdvanceProgress(db, project.id),
    listTrackProgress(db, project.id),
    listRosterReadiness(db, project.id),
    pane === "allocations"
      ? listAllocationHeat(db, project.id)
      : Promise.resolve({ ok: true as const, data: [] as AllocationHeatCell[] }),
  ]);
  const cells = progress.ok ? progress.data : [];
  const trackRows = tracks.ok ? tracks.data : [];
  const readinessCells = readiness.ok ? readiness.data : [];

  // Packets, soonest due first; the filter picks one, else the first.
  const packets = [...new Map(cells.map((c) => [c.packetId, c])).values()];
  const packet = packets.find((p) => p.packetId === search["packet"]) ?? packets[0];

  const tiles = [
    {
      label: t("advancing.progress.tiles.outstanding"),
      caption: t("advancing.progress.tileCaptions.outstanding"),
      value: cells.filter((c) => c.state === "Missing" || c.state === "Returned").length,
    },
    {
      label: t("advancing.progress.tiles.overdue"),
      caption: t("advancing.progress.tileCaptions.overdue"),
      value: cells.filter((c) => c.overdue).length,
    },
    {
      label: t("advancing.progress.tiles.awaitingReview"),
      caption: t("advancing.progress.tileCaptions.awaitingReview"),
      value: cells.filter((c) => c.state === "Awaiting Review").length,
    },
    {
      label: t("advancing.progress.tiles.rosterGaps"),
      caption: t("advancing.progress.tileCaptions.rosterGaps"),
      value: readiness.ok
        ? readinessCells.filter((c) => c.state === "Missing" || c.state === "Awaiting Person")
            .length
        : null,
    },
    {
      label: t("advancing.progress.tiles.tracksReady"),
      caption: t("advancing.progress.tileCaptions.tracksReady"),
      value: trackRows.filter((r) => r.state === "Ready for Sign-off").length,
    },
  ];

  const packetFilter =
    (pane === "packets" || pane === "tracks") && packets.length > 1 ? (
      <SelectFilter
        id="progress-packet"
        label={t("advancing.progress.packetFilter")}
        param="packet"
        value={packet?.packetId ?? ""}
        options={packets.map((p) => ({ value: p.packetId, label: p.packetTitle }))}
      />
    ) : null;

  let body: ReactNode;
  if (pane === "packets" || pane === "tracks") {
    if (!packet) {
      body = (
        <p className="m-0 text-text-13 text-text-secondary">{t("advancing.progress.noPackets")}</p>
      );
    } else if (pane === "packets") {
      const mine = cells.filter((c) => c.packetId === packet.packetId);
      const rows = [...new Map(mine.map((c) => [c.recipientId, c])).values()].map((c) => ({
        id: c.recipientId,
        label: c.recipientLabel ?? t("advancing.recipients.removed"),
      }));
      const cols = [...new Map(mine.map((c) => [c.sectionId, c])).values()]
        .sort((a, b) => a.position - b.position)
        .map((c) => ({ id: c.sectionId, label: c.sectionTitle }));
      const data: HeatmapData = {
        label: t("advancing.progress.heatmap.packets", { packet: packet.packetTitle }),
        corner: t("advancing.progress.corner.recipient"),
        rows,
        cols,
        cells: Object.fromEntries(
          mine.map((c): [string, StatusHeatmapCell] => [
            `${c.recipientId}:${c.sectionId}`,
            {
              state: c.state,
              href: c.latestSubmissionId
                ? `${path}?section=submissions&peek=${c.latestSubmissionId}`
                : `${path}?section=packets&peek=${c.packetId}`,
              ...(c.overdue ? { detail: t("advancing.progress.overdue") } : {}),
            },
          ]),
        ),
        legend: (Object.keys(CELL_ICON) as AdvanceCellState[]).map(
          (s): StatusHeatmapLegendItem => ({
            state: s,
            icon: CELL_ICON[s],
            label: t(`advancing.progress.states.${key(s)}`),
          }),
        ),
      };
      body = (
        <PacketsHeatmap
          org={ctx.org.slug}
          packetId={packet.packetId}
          canRemind={can.send}
          data={data}
        />
      );
    } else {
      const mine = trackRows.filter((r) => r.packetId === packet.packetId);
      const recipientRows = [...new Map(mine.map((r) => [r.recipientId, r])).values()];
      const present = ADVANCE_TRACKS.filter((tr) => mine.some((r) => r.track === tr));
      const trackLabel = (tr: string) => t(`advancing.tracks.names.${key(tr)}`);
      const actions: Record<string, TrackCellAction> = {};
      const cellMap: Record<string, StatusHeatmapCell> = {};
      for (const r of mine) {
        const k = `${r.recipientId}:${r.track}`;
        const when = r.signedOffAt
          ? format.dateTime(new Date(r.signedOffAt), { dateStyle: "medium" })
          : null;
        cellMap[k] = {
          state: r.state,
          detail:
            when && r.signedOffByName
              ? t("advancing.tracks.signedOffBy", { name: r.signedOffByName, date: when })
              : when
                ? t("advancing.tracks.signedOffOn", { date: when })
                : t("advancing.tracks.progress", { done: r.sectionsDone, total: r.sectionsTotal }),
        };
        actions[k] = {
          recipientId: r.recipientId,
          recipientLabel: r.recipientLabel ?? t("advancing.recipients.removed"),
          track: r.track,
          trackLabel: trackLabel(r.track),
          signoffId: r.signoffId,
          offer:
            r.state === "Ready for Sign-off"
              ? "signOff"
              : r.state === "Signed Off" || r.state === "Reopened"
                ? "revoke"
                : null,
        };
      }
      const data: HeatmapData = {
        label: t("advancing.progress.heatmap.tracks", { packet: packet.packetTitle }),
        corner: t("advancing.progress.corner.recipient"),
        rows: recipientRows.map((r) => ({
          id: r.recipientId,
          label: r.recipientLabel ?? t("advancing.recipients.removed"),
        })),
        cols: present.map((tr) => ({ id: tr, label: trackLabel(tr) })),
        cells: cellMap,
        legend: TRACK_STATES.map((s) => ({
          state: s,
          icon: TRACK_ICON[s],
          label: t(`advancing.tracks.states.${key(s)}`),
        })),
      };
      body =
        mine.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("advancing.progress.tracksEmpty")}
          </p>
        ) : (
          <TracksHeatmap org={ctx.org.slug} canReview={can.review} data={data} actions={actions} />
        );
    }
  } else if (pane === "crew") {
    if (!readiness.ok) {
      body = (
        <p className="m-0 text-text-13 text-text-secondary">
          {t("advancing.progress.readiness.refused")}
        </p>
      );
    } else if (readinessCells.length === 0) {
      body = (
        <p className="m-0 text-text-13 text-text-secondary">
          {t("advancing.progress.readiness.empty")}
        </p>
      );
    } else {
      const entries = [...new Map(readinessCells.map((c) => [c.rosterEntryId, c])).values()];
      const states = [...new Set(readinessCells.map((c) => c.state))];
      const data: HeatmapData = {
        label: t("advancing.progress.heatmap.crew"),
        corner: t("advancing.progress.corner.person"),
        rows: entries.map((e) => ({
          id: e.rosterEntryId,
          label: e.personLabel ?? t("advancing.recipients.removed"),
          sublabel: [e.partyLabel, t(`advancing.crew.states.${key(e.entryState)}`)]
            .filter(Boolean)
            .join(" · "),
        })),
        cols: READINESS_CATEGORIES.map((c) => ({
          id: c,
          label: t(`advancing.progress.readiness.categories.${key(c)}`),
        })),
        cells: Object.fromEntries(
          readinessCells.map((c): [string, StatusHeatmapCell] => [
            `${c.rosterEntryId}:${c.category}`,
            { state: c.state, href: `${path}?section=crew&peek=${c.rosterEntryId}` },
          ]),
        ),
        legend: (Object.keys(READINESS_ICON) as ReadinessState[])
          .filter((s) => states.includes(s))
          .map((s) => ({
            state: s,
            icon: READINESS_ICON[s],
            label: t(`advancing.progress.readiness.states.${key(s)}`),
          })),
      };
      body = <LinkedHeatmap data={data} />;
    }
  } else {
    const rows = heat.ok ? heat.data : [];
    const colOf = (c: AllocationHeatCell) => c.offering ?? `${c.kind}`;
    const colLabel = (c: AllocationHeatCell) =>
      c.offering
        ? t(`projects.settings.offerings.kinds.${c.offering}`)
        : c.kind === "Credential"
          ? t("advancing.progress.allocation.badges")
          : c.kind === "Asset"
            ? t("advancing.progress.allocation.sites")
            : t(`advancing.allocations.kinds.${c.kind.toLowerCase().replace(/ /g, "_")}`);
    const parties = [...new Map(rows.map((c) => [c.engagementId ?? "", c])).values()];
    const cols = [...new Map(rows.map((c) => [colOf(c), c])).values()].map((c) => ({
      id: colOf(c),
      label: colLabel(c),
    }));
    const cellMap: Record<string, StatusHeatmapCell> = {};
    for (const c of rows) {
      const state = allocationState(c);
      if (!state) continue;
      cellMap[`${c.engagementId ?? ""}:${colOf(c)}`] = {
        state,
        href: `${path}?section=allocations${c.partyLabel ? `&party=${encodeURIComponent(c.partyLabel)}` : ""}`,
        detail:
          state === "Requested"
            ? t("advancing.progress.allocation.requestedDetail", { n: c.requested })
            : t("advancing.progress.allocation.detail", { issued: c.issued, approved: c.approved }),
      };
    }
    const data: HeatmapData = {
      label: t("advancing.progress.heatmap.allocations"),
      corner: t("advancing.progress.corner.party"),
      rows: parties.map((p) => ({
        id: p.engagementId ?? "",
        label: p.partyLabel ?? t("advancing.recipients.removed"),
      })),
      cols,
      cells: cellMap,
      legend: ALLOCATION_STATES.map((s) => ({
        state: s,
        icon: ALLOCATION_ICON[s],
        label: t(`advancing.progress.allocation.states.${key(s)}`),
      })),
    };
    body =
      rows.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {t("advancing.progress.allocation.empty")}
        </p>
      ) : (
        <LinkedHeatmap data={data} />
      );
  }

  return (
    <CollectionPage gap={16} header={<PageHeader title={title} />}>
      <LiveList
        org={ctx.org.slug}
        tables={["advance_submissions", "engagement_roster_entries", "advance_track_signoffs"]}
      />
      <ul
        aria-label={title}
        className="m-0 grid list-none grid-cols-2 gap-12 p-0 sm:grid-cols-3 lg:grid-cols-5"
      >
        {tiles.map((tile) => (
          <li key={tile.label}>
            <StatTile label={tile.label} value={tile.value} caption={tile.caption} />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-12">
        <ProgressPaneTabs
          label={t("advancing.progress.panes.label")}
          current={pane}
          options={PANES.map((p) => ({ value: p, label: t(`advancing.progress.panes.${p}`) }))}
        />
        {packetFilter}
      </div>
      {body}
    </CollectionPage>
  );
}
