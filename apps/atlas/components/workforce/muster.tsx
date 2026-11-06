import { listCredentialCategories, listProjectZones } from "@xos/data/credentials";
import {
  listMuster,
  MUSTER_LIMIT,
  musterAccess,
  musterByZone,
  type MusterRow,
} from "@xos/data/workforce-site";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { EmptyRefresh, ErrorPanel } from "@/components/collection-kit/kit";
import { InlineAlert, PageHeader } from "@/components/collection-kit/ui";
import { EmptyStateLink } from "@/components/ui";
import type { SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { nodeHref } from "@/lib/shell/sitemap";
import { CollectionPage } from "@/components/platform/collection-page";
import { CollectionViews } from "@/components/views/collection-views";
import { MusterLastRead } from "./muster-last-read";
import { MusterRefresh } from "./muster-refresh";
import { PrintButton } from "./print-button";
import { ProjectPicker, chosenProject, orgPickers, workforceCopy } from "./shared";

const SOURCE_KEY = {
  Scan: "Scan",
  "Clock In": "ClockIn",
  "Guest Check In": "GuestCheckIn",
} as const;

const VIEWS = ["table", "list"] as const;
type MusterView = (typeof VIEWS)[number];

/**
 * Site Operations > Muster List (Section 4.9, B8 gap G-149, app.muster_list): everyone placed in a zone now by an entry
 * scan or a geofenced clock-in, and the guests checked in in the last 24 hours, grouped by zone with the count of each,
 * as a table or a list. It shows only the people the viewer may see, and says which sources it leaves out. Zones are
 * listed by code and name (no map, S5-29). It reads itself again every 30 seconds unless paused; it prints with each
 * zone's heading and the column headers on every page, and exports CSV, .xlsx or PDF through the view switcher's
 * export menu (the collection export of app.muster_list, Section 8.6).
 */
export async function MusterSection({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const [t, format, pickers] = await Promise.all([
    workforceCopy(),
    getFormatter(),
    orgPickers(ctx),
  ]);
  const title = t("muster.title");
  const project = chosenProject(pickers.projects, search);
  if (project === null) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <EmptyStateLink
          icon="FolderPlus"
          sentence={t("site.noProjects")}
          actionLabel={t("site.openProjects")}
          href={nodeHref("projects.all", { org: ctx.org.slug }) ?? "/"}
        />
      </CollectionPage>
    );
  }
  // The export reads the URL, so the project on screen is always in it.
  if (search["project"] === undefined) redirect(`${path}?project=${project.id}` as Route);
  const db = ctx.viewer.db;
  const picker = <ProjectPicker t={t} path={path} projects={pickers.projects} current={project} />;
  const access = await musterAccess(db, project.id);
  if (access.ok && !access.data.scans && !access.data.clockIns && !access.data.guests) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        {picker}
        <EmptyRefresh icon="Lock" sentence={t("muster.noAccess")} />
      </CollectionPage>
    );
  }
  const rawZone = search["zone"];
  const zoneParam = Array.isArray(rawZone) ? rawZone[0] : rawZone;
  const [zones, categories] = await Promise.all([
    listProjectZones(db, ctx.org.id, project.venueId),
    listCredentialCategories(db, { orgId: ctx.org.id, projectId: project.id }),
  ]);
  const zoneList = zones.ok ? zones.data : [];
  const zoneId = zoneList.some((z) => z.id === zoneParam) ? (zoneParam ?? null) : null;
  const rows = access.ok ? await listMuster(db, { projectId: project.id, zoneId }) : access;
  const staleNote = t("muster.stale");
  // A read that fails keeps the last list on screen, in the same place in the page, and the next refresh replaces it.
  if (!access.ok || !rows.ok) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <MusterLastRead
          failed
          note={staleNote}
          fallback={
            <>
              {picker}
              <ErrorPanel what={t("muster.what")} />
            </>
          }
        />
      </CollectionPage>
    );
  }
  const zoneById = new Map(zoneList.map((z) => [z.id, z]));
  const categoryById = new Map(
    (categories.ok ? categories.data : []).map((c) => [c.id, `${c.code} · ${c.name}`]),
  );
  const rawView = search["view"];
  const viewParam = Array.isArray(rawView) ? rawView[0] : rawView;
  const view: MusterView = viewParam === "list" ? "list" : "table";
  // Which sources this viewer cannot read, said on the page so a short list is not taken as complete.
  const hidden = [
    access.data.scans ? null : t("muster.hiddenScans"),
    access.data.clockIns ? null : t("muster.hiddenClockIns"),
    access.data.guests ? null : t("muster.hiddenGuests"),
    access.data.guests && !access.data.doors ? t("muster.hiddenDoors") : null,
  ].filter((line): line is string => line !== null);
  const category = (r: MusterRow) =>
    r.credentialCategoryId
      ? (categoryById.get(r.credentialCategoryId) ?? r.categoryCode ?? "")
      : (r.categoryCode ?? "");
  const since = (iso: string) =>
    format.dateTime(new Date(iso), {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: project.timeZone,
    });
  const groups = musterByZone(
    rows.data.slice(0, MUSTER_LIMIT),
    zoneList.map((z) => z.id),
  );
  const zoneLabel = (id: string | null, row?: MusterRow) => {
    if (id === null) return t("muster.noZone");
    const z = zoneById.get(id);
    if (z) return `${z.code} · ${z.name}`;
    return row?.zoneCode ? `${row.zoneCode} · ${row.zoneName ?? ""}` : id;
  };
  // One more than the limit is read, so the notice shows only when people are really left out.
  const cutShort = rows.data.length > MUSTER_LIMIT;
  const place = (r: MusterRow) =>
    r.source === "Guest Check In"
      ? r.door
        ? t("muster.guestAt", { door: r.door })
        : t("muster.noZone")
      : zoneLabel(r.zoneId, r);

  return (
    <CollectionPage header={<PageHeader title={title} />}>
      <MusterLastRead failed={false} note={staleNote} fallback={null}>
        <div className="flex flex-wrap items-end justify-between gap-16 print:hidden">
          <div className="flex flex-wrap items-end gap-16">
            {picker}
            <form method="get" action={path} className="flex flex-wrap items-end gap-8">
              <input type="hidden" name="project" value={project.id} />
              <div className="flex flex-col gap-4">
                <label htmlFor="muster-zone" className="text-label-13 font-medium">
                  {t("muster.zone")}
                </label>
                <select
                  id="muster-zone"
                  name="zone"
                  defaultValue={zoneId ?? ""}
                  className="h-control-md max-w-full rounded-control border border-border-control bg-bg-surface px-8 text-text-13"
                >
                  <option value="">{t("muster.allZones")}</option>
                  {zoneList.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.code} · {z.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                className="h-control-md rounded-control border border-border-control bg-bg-surface px-12 text-text-13 font-medium"
              >
                {t("site.show")}
              </button>
            </form>
          </div>
          <div className="flex flex-wrap items-center gap-8">
            <MusterRefresh
              updated={t("muster.updated", { time: since(new Date().toISOString()) })}
              pauseLabel={t("muster.pause")}
              resumeLabel={t("muster.resume")}
            />
            <PrintButton label={t("muster.print")} />
          </div>
        </div>
        <div className="print:hidden">
          <CollectionViews
            label={t("muster.views")}
            value={view}
            options={VIEWS.map((v) => ({ value: v, label: t(`muster.view.${v}`) }))}
          />
        </div>
        <p className="m-0 text-text-13 text-text-secondary">{t("muster.what")}</p>
        {hidden.length > 0 ? (
          <ul
            aria-label={t("muster.hiddenLabel")}
            className="m-0 flex list-disc flex-col gap-2 pl-20 text-text-13"
          >
            {hidden.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {cutShort ? (
          <InlineAlert tone="warning">
            {t("muster.truncated", { count: format.number(MUSTER_LIMIT) })}
          </InlineAlert>
        ) : null}
        <p className="m-0 hidden text-text-13 print:block">
          {project.key} {project.name} · {since(new Date().toISOString())}
        </p>
        {groups.length === 0 ? (
          <EmptyRefresh icon="Users" sentence={t("muster.empty")} />
        ) : (
          groups.map((g) => (
            <section
              key={g.zoneId ?? "doors"}
              aria-labelledby={`muster-${g.zoneId ?? "doors"}`}
              className="flex flex-col gap-8 print:break-inside-avoid-page"
            >
              <h2 id={`muster-${g.zoneId ?? "doors"}`} className="m-0 text-text-14 font-semibold">
                {zoneLabel(g.zoneId)} ·{" "}
                {t("muster.zoneCount", {
                  count: g.rows.reduce((n, r) => n + 1 + (r.plusOnes ?? 0), 0),
                })}
              </h2>
              {view === "list" ? (
                <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0 text-text-13">
                  {g.rows.map((r, i) => (
                    <li
                      key={`${r.personId ?? r.guestName ?? ""}-${r.enteredAt}-${i}`}
                      className="flex flex-col gap-2 py-6 print:break-inside-avoid"
                    >
                      <span className="font-semibold">{r.name ?? t("someone")}</span>
                      <span className="text-text-secondary">
                        {[
                          place(r),
                          since(r.enteredAt),
                          t(`muster.sources.${SOURCE_KEY[r.source]}`),
                          category(r),
                          r.partyName ?? "",
                          r.plusOnes ? t("muster.plusOnesLine", { count: r.plusOnes }) : "",
                        ]
                          .filter((part) => part !== "")
                          .join(" · ")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-text-13">
                    <caption className="sr-only">{zoneLabel(g.zoneId)}</caption>
                    <thead className="[display:table-header-group]">
                      <tr className="border-b border-border-subtle">
                        <th scope="col" className="py-6 pr-12 font-semibold">
                          {t("muster.name")}
                        </th>
                        <th scope="col" className="py-6 pr-12 font-semibold">
                          {t("muster.zone")}
                        </th>
                        <th scope="col" className="py-6 pr-12 font-semibold">
                          {t("muster.since")}
                        </th>
                        <th scope="col" className="py-6 pr-12 font-semibold">
                          {t("muster.source")}
                        </th>
                        <th scope="col" className="py-6 pr-12 font-semibold">
                          {t("muster.category")}
                        </th>
                        <th scope="col" className="py-6 pr-12 font-semibold">
                          {t("muster.party")}
                        </th>
                        <th scope="col" className="py-6 pr-12 font-semibold">
                          {t("muster.plusOnes")}
                        </th>
                        <th scope="col" className="py-6 font-semibold">
                          {t("muster.door")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.rows.map((r, i) => (
                        <tr
                          key={`${r.personId ?? r.guestName ?? ""}-${r.enteredAt}-${i}`}
                          className="border-b border-border-subtle print:break-inside-avoid"
                        >
                          <th scope="row" className="py-6 pr-12 font-normal">
                            {r.name ?? t("someone")}
                          </th>
                          <td className="py-6 pr-12">{place(r)}</td>
                          <td className="py-6 pr-12">{since(r.enteredAt)}</td>
                          <td className="py-6 pr-12">
                            {t(`muster.sources.${SOURCE_KEY[r.source]}`)}
                          </td>
                          <td className="py-6 pr-12">{category(r)}</td>
                          <td className="py-6 pr-12">{r.partyName ?? ""}</td>
                          <td className="py-6 pr-12 tabular-nums">
                            {r.plusOnes ? `+${r.plusOnes}` : ""}
                          </td>
                          <td className="py-6">{r.door ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))
        )}
      </MusterLastRead>
    </CollectionPage>
  );
}
