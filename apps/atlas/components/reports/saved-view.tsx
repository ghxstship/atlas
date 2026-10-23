import { listCounterparties } from "@xos/data/finance";
import { listMyRuns, listSavedReports, listSharedReports } from "@xos/data/reports";
import { listEngagementRefs } from "@xos/data/settlements";
import { getNode } from "@xos/ia";
import Link from "next/link";
import type { Route } from "next";
import type { FinancePage } from "@/lib/finance/context";
import { getFinanceCopy } from "@/lib/finance/copy";
import { sitemap } from "@/lib/shell/sitemap";
import { Section, SimpleTable } from "@/components/finance/figures";
import { CollectionList } from "@/components/finance/kit-collection-list";
import { CollectionTable } from "@/components/finance/kit-collection-table";
import { RecordPeek } from "@/components/finance/kit-record-peek";
import { ViewSwitcher } from "@/components/finance/kit-view-switcher";
import { EmptyPanel, ErrorPanel, RefusalPanel } from "@/components/finance/panels";
import { PageHeader, TemplateCollection } from "@/components/finance/ui";
import { RevokeShareButton, RunReportForm, ShareReportForm } from "./client";
import { ReportDeliveryPanel } from "./delivery-panel";

/**
 * Reports > Saved reports (Section 4.5.5, 4.6.4) and the project Reports tab (Section 4.5.4). Saved
 * reports are A18's report builder definitions; from here a member runs one as PDF, CSV or .xlsx, and
 * shares a finished run with a client engagement (0992), so it appears under the client's Reports tab
 * in Gateway until it expires or is revoked. The project tab adds the built-in reports for the project.
 */
export async function SavedReportsView({ page }: { page: FinancePage }) {
  const { ctx, access, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const node = page.inProject ? "project.reports" : "reports.saved-reports";
  const title = t(getNode(sitemap, node).node.label);
  const org = ctx.org.slug;
  if (!access.can("reports.report.read")) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <RefusalPanel capability="reports.report.read" href={`/${org}/home`} />
      </TemplateCollection>
    );
  }
  const db = ctx.viewer.db;
  const scope = { orgId: ctx.org.id, projectId: page.project?.id ?? null };
  const [reports, runs, shares, engagements, counterparties] = await Promise.all([
    listSavedReports(db, { orgId: ctx.org.id, membershipId: ctx.org.membershipId }),
    listMyRuns(db, { orgId: ctx.org.id, membershipId: ctx.org.membershipId }),
    listSharedReports(db, scope),
    listEngagementRefs(db, scope),
    listCounterparties(db, ctx.org.id),
  ]);
  if (!reports.ok || !runs.ok || !shares.ok) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <ErrorPanel sentence={t("reports.saved.loadError")} />
      </TemplateCollection>
    );
  }
  const canExport = access.can("reports.report.export");
  const projectKey = new Map(page.projects.map((p) => [p.id, p.key]));
  const partyName = new Map(
    (counterparties.ok ? counterparties.data : []).map((p) => [p.id, p.name ?? ""]),
  );
  const engagementList = engagements.ok ? engagements.data : [];
  const engagementLabel = new Map(
    engagementList.map((e) => [
      e.id,
      `${projectKey.get(e.projectId) ?? ""} · ${(e.counterpartyId && partyName.get(e.counterpartyId)) || e.personName || ""} · ${e.roleType}`,
    ]),
  );
  const shareTargets = engagementList
    .filter((e) => ["Client", "Sponsor"].includes(e.roleType) && !["Canceled"].includes(e.state))
    .map((e) => ({ value: e.id, label: engagementLabel.get(e.id) ?? e.id }));
  const term = query.q?.toLowerCase() ?? null;
  const shown = reports.data.filter((r) => term === null || r.name.toLowerCase().includes(term));
  const peek = query.peek ? reports.data.find((r) => r.id === query.peek) : undefined;
  const builtIns = [
    "reports.gate-readiness",
    "reports.coordinate-matrix",
    "reports.budget-versus-actual",
    "reports.labor",
    "reports.purchase-order-exposure",
    "reports.incidents",
    "reports.final-cost-report",
    "reports.measurement",
  ];
  const runStatus = (s: string) => t(`reports.saved.status.${s}`);
  const finished = runs.data.filter((r) => r.status === "Succeeded");

  return (
    <TemplateCollection
      header={
        <PageHeader
          title={title}
          count={shown.length}
          views={<ViewSwitcher views={page.views} value={page.view} />}
          actions={
            access.can("reports.report.write") ? (
              <Link
                href={`/${org}/reports/builder` as Route}
                className="inline-flex h-control-md items-center rounded-control bg-accent px-12 text-text-13 font-medium text-accent-text-on"
              >
                {t("reports.saved.build")}
              </Link>
            ) : undefined
          }
        />
      }
      peek={
        peek ? (
          <RecordPeek
            kindLabel={t("reports.saved.kind")}
            recordKey={t(`reports.saved.sources.${peek.sourceCode}`)}
            title={peek.name}
            state={peek.shared ? "active" : "ready"}
            stateLabel={peek.shared ? t("reports.saved.shared") : t("reports.saved.private")}
            properties={[
              {
                label: t("reports.saved.source"),
                value: t(`reports.saved.sources.${peek.sourceCode}`),
              },
              { label: t("reports.saved.chart"), value: peek.chart },
              {
                label: t("reports.saved.owner"),
                value: peek.mine ? t("reports.saved.you") : t("reports.saved.someoneElse"),
              },
            ]}
          >
            <RunReportForm org={org} reportDefinitionId={peek.id} />
            <ReportDeliveryPanel
              ctx={ctx}
              reportDefinitionId={peek.id}
              canPlace={access.can("reports.report.read")}
              canSchedule={peek.mine && access.can("reports.schedule.write")}
            />
            <SimpleTable
              caption={t("reports.saved.recentRuns")}
              head={[
                t("reports.saved.when"),
                t("reports.format"),
                t("finance.common.state"),
                t("reports.saved.rows"),
              ]}
              rows={runs.data
                .filter((r) => r.reportDefinitionId === peek.id)
                .map((r) => [
                  c.dateTime(r.createdAt),
                  r.format,
                  runStatus(r.status),
                  r.rowCount === null ? "" : c.number(r.rowCount),
                ])}
            />
          </RecordPeek>
        ) : null
      }
    >
      <div className="flex flex-col gap-24">
        {page.inProject ? (
          <Section id="built-in" title={t("reports.saved.builtIn")}>
            <ul className="m-0 grid list-none grid-cols-2 gap-8 p-0 max-sm:grid-cols-1">
              {builtIns.map((n) => {
                const route = getNode(sitemap, n).node.route ?? "";
                return (
                  <li key={n}>
                    <Link
                      href={
                        `${route.replace("{org}", org)}?project=${page.project?.key ?? ""}` as Route
                      }
                      className="flex min-h-row-comfortable items-center rounded-card border border-border-subtle px-12 text-text-14 text-text-primary hover:bg-bg-hover"
                    >
                      {t(getNode(sitemap, n).node.label)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Section>
        ) : null}
        <Section id="saved" title={t("reports.saved.definitions")}>
          {shown.length === 0 ? (
            <EmptyPanel
              icon="BarChart3"
              sentence={t("reports.saved.empty")}
              actionLabel={t("reports.saved.build")}
              href={`/${org}/reports/builder`}
            />
          ) : page.view === "table" ? (
            <CollectionTable
              label={t("reports.saved.definitions")}
              columns={[
                { key: "name", label: t("reports.saved.name"), wrap: true },
                { key: "source", label: t("reports.saved.source") },
                { key: "chart", label: t("reports.saved.chart") },
                { key: "shared", label: t("reports.saved.visibility") },
              ]}
              rows={shown.map((r) => ({
                id: r.id,
                name: r.name,
                source: t(`reports.saved.sources.${r.sourceCode}`),
                chart: r.chart,
                shared: r.shared ? t("reports.saved.shared") : t("reports.saved.private"),
              }))}
            />
          ) : (
            <CollectionList
              label={t("reports.saved.definitions")}
              items={shown.map((r) => ({
                id: r.id,
                recordKey: t(`reports.saved.sources.${r.sourceCode}`),
                title: r.name,
                state: r.shared ? "active" : "ready",
                stateLabel: r.shared ? t("reports.saved.shared") : t("reports.saved.private"),
              }))}
            />
          )}
        </Section>
        <Section id="share" title={t("reports.saved.shareTitle")}>
          <p className="m-0 max-w-layout-reading text-text-12 text-text-secondary">
            {t("reports.saved.shareSentence")}
          </p>
          {!canExport ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {t("reports.saved.shareNeedsCapability")}
            </p>
          ) : finished.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {t("reports.saved.noFinishedRuns")}
            </p>
          ) : shareTargets.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {t("reports.saved.noClientEngagements")}
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-12 p-0">
              {finished.slice(0, 5).map((r) => (
                <li
                  key={r.id}
                  className="flex flex-col gap-6 rounded-card border border-border-subtle p-12"
                >
                  <span className="text-text-13 font-medium">
                    {r.reportName} · {r.format} · {r.finishedAt ? c.dateTime(r.finishedAt) : ""}
                  </span>
                  <ShareReportForm
                    org={org}
                    reportRunId={r.id}
                    title={r.reportName}
                    engagements={shareTargets}
                  />
                </li>
              ))}
            </ul>
          )}
          {shares.data.length > 0 ? (
            <SimpleTable
              caption={t("reports.saved.sharedWith")}
              head={[
                t("reports.shareTitle"),
                t("reports.shareWith"),
                t("reports.shareExpires"),
                t("finance.common.state"),
                t("finance.common.actions"),
              ]}
              rows={shares.data.map((s) => [
                s.title,
                engagementLabel.get(s.engagementId) ?? "",
                s.expiresAt ? c.date(s.expiresAt) : t("reports.saved.noExpiry"),
                s.revokedAt
                  ? t("reports.saved.revoked")
                  : s.expiresAt && s.expiresAt < new Date().toISOString()
                    ? t("reports.saved.expired")
                    : t("reports.saved.live"),
                s.revokedAt || !canExport ? "" : <RevokeShareButton key="r" org={org} id={s.id} />,
              ])}
            />
          ) : null}
        </Section>
      </div>
    </TemplateCollection>
  );
}
