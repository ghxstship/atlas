import { listDashboards, listTiles, type DashboardTile } from "@xos/data/dashboards";
import { listProjects } from "@xos/data/finance";
import {
  getReportDefinition,
  previewReport,
  type PreviewCell,
  type ReportPreview,
} from "@xos/data/report-builder";
import { getNode } from "@xos/ia";
import Link from "next/link";
import type { Route } from "next";
import type { CSSProperties } from "react";
import { deleteDashboardAction, removeTileAction } from "@/app/[org]/reports/dashboards/actions";
import { InlineActionButton } from "@/components/finance/kit";
import { EmptyPanel, ErrorPanel, RefusalPanel } from "@/components/finance/panels";
import { PageHeader, TemplateCollection } from "@/components/finance/ui";
import { withQuery, type FinancePage } from "@/lib/finance/context";
import { getFinanceCopy } from "@/lib/finance/copy";
import { sitemap } from "@/lib/shell/sitemap";
import { CreateDashboardForm } from "./dashboards-client";

type Copy = Awaited<ReturnType<typeof getFinanceCopy>>;

/** Rows a tile shows; the full set is one click away on the saved report. */
const TILE_ROWS = 8;

/**
 * Reports > Dashboards (A43, finding A38-004; Section 4.6.4, journey 29): the viewer's dashboards and
 * their teams', and one dashboard as a 12-column grid of saved reports. Each tile reads its report as
 * the viewer, so it shows only what they may see, with NULL-aware totals: an unpriced amount stays out
 * of a total and is counted beside it, never read as zero.
 */
export async function DashboardsView({ page }: { page: FinancePage }) {
  const { ctx, access, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const title = t(getNode(sitemap, "reports.dashboards").node.label);
  const org = ctx.org.slug;
  if (!access.can("reports.report.read")) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <RefusalPanel capability="reports.report.read" href={`/${org}/home`} />
      </TemplateCollection>
    );
  }
  const db = ctx.viewer.db;
  const dashboards = await listDashboards(db, {
    orgId: ctx.org.id,
    membershipId: ctx.org.membershipId,
  });
  if (!dashboards.ok) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <ErrorPanel sentence={t("reporting.dashboards.loadError")} />
      </TemplateCollection>
    );
  }
  const open = query.extra["dashboard"]
    ? dashboards.data.find((d) => d.id === query.extra["dashboard"])
    : undefined;
  const header = (
    <PageHeader
      title={open ? open.name : title}
      {...(open ? {} : { count: dashboards.data.length })}
    />
  );

  if (!open) {
    return (
      <TemplateCollection header={header}>
        <div className="flex flex-col gap-24">
          <CreateDashboardForm org={org} />
          {dashboards.data.length === 0 ? (
            <EmptyPanel
              icon="BarChart3"
              sentence={t("reporting.dashboards.empty")}
              actionLabel={t("reporting.dashboards.emptyAction")}
              href={`/${org}/reports/saved-reports`}
            />
          ) : (
            <ul className="m-0 grid list-none grid-cols-3 gap-12 p-0 max-lg:grid-cols-2 max-sm:grid-cols-1">
              {dashboards.data.map((d) => (
                <li key={d.id}>
                  <Link
                    href={withQuery(page, { dashboard: d.id }) as Route}
                    className="flex min-h-row-comfortable flex-col gap-4 rounded-card border border-border-subtle p-16 text-text-primary hover:bg-bg-hover"
                  >
                    <span className="text-text-14 font-semibold">{d.name}</span>
                    <span className="text-text-12 text-text-secondary">
                      {d.teamId
                        ? t("reporting.dashboards.team")
                        : t("reporting.dashboards.personal")}{" "}
                      · {t("reporting.dashboards.tiles", { count: d.tileCount })}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </TemplateCollection>
    );
  }

  const [tiles, projects] = await Promise.all([
    listTiles(db, open.id),
    listProjects(db, ctx.org.id),
  ]);
  if (!tiles.ok || !projects.ok) {
    return (
      <TemplateCollection header={header}>
        <ErrorPanel sentence={t("reporting.dashboards.loadError")} />
      </TemplateCollection>
    );
  }
  const projectIds = projects.data.map((p) => p.id);
  const previews = await Promise.all(
    tiles.data.map(async (tile) => {
      const definition = await getReportDefinition(db, {
        id: tile.reportDefinitionId,
        membershipId: ctx.org.membershipId,
      });
      if (!definition.ok) return null;
      const preview = await previewReport(db, {
        orgId: ctx.org.id,
        projectIds,
        definition: definition.data,
      });
      return preview.ok
        ? {
            preview: preview.data,
            sourceCode: definition.data.sourceCode,
            group: definition.data.groupBy,
          }
        : null;
    }),
  );
  return (
    <TemplateCollection header={header}>
      <div className="flex flex-col gap-16">
        <div className="flex flex-wrap items-center gap-12 text-text-13">
          <Link
            href={withQuery(page, { dashboard: null }) as Route}
            className="text-accent-text underline"
          >
            {t("reporting.dashboards.back")}
          </Link>
          <Link
            href={`/${org}/reports/saved-reports` as Route}
            className="text-accent-text underline"
          >
            {t("reporting.dashboards.addFromSaved")}
          </Link>
          <span className="ms-auto">
            <InlineActionButton
              action={deleteDashboardAction}
              fields={{ org, id: open.id }}
              label={t("reporting.dashboards.deleteDashboard")}
              icon="Trash2"
            />
          </span>
        </div>
        {tiles.data.length === 0 ? (
          <EmptyPanel
            icon="BarChart3"
            sentence={t("reporting.dashboards.noTiles")}
            actionLabel={t("reporting.dashboards.addFromSaved")}
            href={`/${org}/reports/saved-reports`}
          />
        ) : (
          <ul
            aria-label={t("reporting.dashboards.grid")}
            className="m-0 grid list-none grid-cols-12 gap-12 p-0 max-md:grid-cols-1"
          >
            {tiles.data.map((tile, i) => (
              <Tile key={tile.id} tile={tile} data={previews[i] ?? null} c={c} org={org} />
            ))}
          </ul>
        )}
      </div>
    </TemplateCollection>
  );
}

function Tile({
  tile,
  data,
  c,
  org,
}: {
  tile: DashboardTile;
  data: { preview: ReportPreview; sourceCode: string; group: string | null } | null;
  c: Copy;
  org: string;
}) {
  const { t } = c;
  const place: CSSProperties = {
    gridColumn: `${tile.gridColumn} / span ${tile.columnSpan}`,
    gridRow: `${tile.gridRow} / span ${tile.rowSpan}`,
  };
  const field = (source: string, key: string) => t(`workflow.builder.fields.${source}.${key}`);
  const cell = (v: PreviewCell): string => {
    if (v.kind === "value") {
      if (v.value === null) return "";
      return typeof v.value === "number" ? c.number(v.value) : String(v.value);
    }
    return c.money(v.totalMinor, v.currency);
  };
  const unpriced = data
    ? data.preview.rows.reduce(
        (n, r) =>
          n + Math.max(0, ...r.cells.map((x) => (x.kind === "money" ? x.unpricedCount : 0))),
        0,
      )
    : 0;
  return (
    <li
      style={place}
      className="flex min-w-0 flex-col gap-8 rounded-card border border-border-subtle bg-bg-raised p-12 max-md:![grid-column:auto] max-md:![grid-row:auto]"
    >
      <div className="flex items-start justify-between gap-8">
        <Link
          href={`/${org}/reports/saved-reports?peek=${tile.reportDefinitionId}` as Route}
          className="text-text-14 font-semibold text-text-primary underline"
        >
          {tile.reportName}
        </Link>
        <InlineActionButton
          action={removeTileAction}
          fields={{ org, id: tile.id }}
          label={t("reporting.dashboards.removeTile")}
          icon="X"
        />
      </div>
      {!data ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {t("reporting.dashboards.tileError")}
        </p>
      ) : data.preview.rows.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {t("reporting.dashboards.tileEmpty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-text-12">
            <caption className="sr-only">{tile.reportName}</caption>
            <thead>
              <tr className="text-text-secondary">
                {data.group ? (
                  <th scope="col" className="py-4 pe-8 text-start font-medium">
                    {field(data.sourceCode, data.group)}
                  </th>
                ) : null}
                {data.preview.columns.map((col) => (
                  <th
                    key={`${col.field}-${col.aggregate}`}
                    scope="col"
                    className={`py-4 pe-8 font-medium ${col.type === "money" || col.type === "number" ? "text-end" : "text-start"}`}
                  >
                    {col.aggregate === "None"
                      ? field(data.sourceCode, col.field)
                      : t("workflow.builder.columnAggregate", {
                          aggregate: t(`workflow.builder.aggregates.${col.aggregate}`),
                          field: field(data.sourceCode, col.field),
                        })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.preview.rows.slice(0, TILE_ROWS).map((r, j) => (
                <tr key={`${r.group ?? ""}-${j}`} className="border-t border-border-subtle">
                  {data.group ? <td className="py-4 pe-8">{r.group ?? ""}</td> : null}
                  {r.cells.map((x, k) => (
                    <td
                      key={k}
                      className={`py-4 pe-8 tabular-nums ${x.kind === "money" || typeof (x as { value?: unknown }).value === "number" ? "text-end" : ""}`}
                    >
                      {cell(x)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {unpriced > 0 ? (
        <p className="m-0 text-text-12 text-warning-text">
          {t("reporting.dashboards.unpricedNote", { count: unpriced })}
        </p>
      ) : null}
      {data && (data.preview.truncated || data.preview.rows.length > TILE_ROWS) ? (
        <p className="m-0 text-text-12 text-text-secondary">
          {t("reporting.dashboards.truncated")}
        </p>
      ) : null}
    </li>
  );
}
