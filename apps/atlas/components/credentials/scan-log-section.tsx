import {
  insideNow,
  listAccessScans,
  listProjectZones,
  SCAN_DIRECTIONS,
  type AccessScan,
} from "@xos/data/credentials";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import { dateTime, Header, ProjectFilter, unwrap } from "@/components/operations/chrome";
import { ActionForm } from "@/components/operations/action-form";
import { ReportedActionForm } from "@/components/operations/reported-action-form";
import { ResultRegion } from "@/components/operations/result-region";
import { SelectField, TextField } from "@/components/operations/fields";
import {
  joined,
  OpsList,
  OpsTable,
  param,
  RecordSection,
  type Column,
} from "@/components/operations/kit";
import { EmptyStateLink } from "@/components/ui";
import { overrideScanAction, recordScanAction } from "@/lib/credentials/actions";
import { can, chooseView, type ModulePage } from "@/lib/operations/context";
import { ScanIntakeQueue } from "./scan-intake";
import { CollectionPage } from "@/components/platform/collection-page";
import { InsideNow } from "./inside-now";
import { ResultChip } from "./scan-rows";

const OVERRIDE_WINDOW_MS = 15 * 60_000;

/** Whether a denial is still young enough to override, at the time the page is read. */
function overridable(scannedAt: string): boolean {
  return new Date().getTime() - Date.parse(scannedAt) < OVERRIDE_WINDOW_MS;
}

// Scan log ---------------------------------------------------------------------------------------

export async function ScanLogSection({ page }: { page: ModulePage }) {
  const t = page.t;
  const section = "scan-log";
  const format = await getFormatter();
  const { views, view } = chooseView("credentials.scan-log", param(page.search, "view"));
  const resultFilter = param(page.search, "result");
  const scanResult =
    resultFilter === "Granted" || resultFilter === "Denied" ? resultFilter : undefined;
  const directionFilter = param(page.search, "direction");
  const scanDirection =
    directionFilter === "In" || directionFilter === "Out" ? directionFilter : undefined;
  const scans = unwrap(
    await listAccessScans(page.ctx.viewer.db, {
      orgId: page.ctx.org.id,
      ...(page.project ? { projectId: page.project.id } : {}),
      ...(scanResult ? { result: scanResult } : {}),
      ...(scanDirection ? { direction: scanDirection } : {}),
    }),
    "scans",
  );
  const title = t("nav.atlas.pages.credentials.scanLog");
  const canScan = can(page, "credentials.scan.write");
  const zones =
    page.project && canScan
      ? unwrap(
          await listProjectZones(page.ctx.viewer.db, page.ctx.org.id, page.project.venueId),
          "zones",
        )
      : [];
  const timeZone = page.project?.timeZone;
  const inside =
    page.project && can(page, "credentials.scan_log.read")
      ? unwrap(
          await insideNow(page.ctx.viewer.db, {
            orgId: page.ctx.org.id,
            projectId: page.project.id,
            venueId: page.project.venueId,
          }),
          "insideNow",
        )
      : null;
  // Denied In scans a supervisor may still let in: under 15 minutes old and not overridden yet (2970).
  const overridden = new Set(
    scans.flatMap((s) => (s.overrideOfScanId ? [s.overrideOfScanId] : [])),
  );
  const recentDenials =
    page.project && can(page, "credentials.credential.issue")
      ? scans.filter(
          (s) =>
            s.result === "Denied" &&
            s.direction === "In" &&
            s.refusalReason !== "Revoked" &&
            !overridden.has(s.id) &&
            overridable(s.scannedAt),
        )
      : [];

  const columns: Column<AccessScan>[] = [
    {
      key: "when",
      label: t("credentials.scans.when"),
      primary: true,
      render: (s) => dateTime(format, s.scannedAt, timeZone),
    },
    {
      key: "direction",
      label: t("credentials.scans.direction"),
      render: (s) => t(`credentials.scans.directions.${s.direction}`),
    },
    {
      key: "number",
      label: t("credentials.issued.number"),
      render: (s) => <span className="font-mono">{s.credentialNumber}</span>,
    },
    {
      key: "holder",
      label: t("credentials.issued.holder"),
      primary: true,
      render: (s) => s.holderName ?? t("credentials.common.unnamed"),
    },
    {
      key: "zone",
      label: t("credentials.grid.zone"),
      render: (s) => `${s.zoneCode} · ${s.zoneName}`,
    },
    { key: "project", label: t("credentials.common.project"), render: (s) => s.projectKey },
    {
      key: "result",
      label: t("credentials.scans.result"),
      primary: true,
      render: (s) => <ResultChip page={page} scan={s} />,
    },
  ];

  return (
    <CollectionPage
      header={
        <Header
          page={page}
          section={section}
          title={title}
          count={scans.length}
          views={views}
          view={view}
        />
      }
    >
      <ProjectFilter
        page={page}
        section={section}
        extra={[
          {
            name: "result",
            label: t("credentials.scans.result"),
            value: scanResult ?? "",
            options: [
              { value: "", label: t("credentials.scans.anyResult") },
              { value: "Granted", label: t("credentials.scans.granted") },
              { value: "Denied", label: t("credentials.scans.denied") },
            ],
          },
          {
            name: "direction",
            label: t("credentials.scans.direction"),
            value: scanDirection ?? "",
            options: [
              { value: "", label: t("credentials.scans.allDirections") },
              ...SCAN_DIRECTIONS.map((d) => ({
                value: d,
                label: t(`credentials.scans.directions.${d}`),
              })),
            ],
          },
        ]}
      />
      {inside && page.project ? (
        <InsideNow
          org={page.ctx.org.slug}
          projectKey={page.project.key}
          initial={{ zones: inside, at: new Date().toISOString() }}
          timeZone={page.project.timeZone}
        />
      ) : null}
      {canScan && page.project && zones.length > 0 ? (
        <RecordSection id="scan-desk" title={t("credentials.scans.deskHeading")}>
          <p className="m-0 text-text-13 text-text-secondary">{t("credentials.scans.deskHelp")}</p>
          <ActionForm
            action={recordScanAction}
            hidden={{ org: page.ctx.org.slug }}
            submitLabel={t("credentials.scans.check")}
            successKey="credentials.scans.decided"
            layout="inline"
            resetOnSuccess
          >
            <SelectField
              id="scan-zone"
              name="zoneId"
              label={t("credentials.grid.zone")}
              options={zones.map((z) => ({
                value: z.id,
                label: joined(z.code, z.name, z.venueName),
              }))}
              required
            />
            <SelectField
              id="scan-direction"
              name="direction"
              label={t("credentials.scans.directionLabel")}
              options={SCAN_DIRECTIONS.map((d) => ({
                value: d,
                label: t(`credentials.scans.directions.${d}`),
              }))}
            />
            <TextField
              id="scan-number"
              name="credentialNumber"
              label={t("credentials.scans.number")}
              help={t("credentials.scans.numberHelp")}
              required
              maxLength={40}
            />
          </ActionForm>
        </RecordSection>
      ) : null}
      <ResultRegion>
        {recentDenials.length > 0 ? (
          <RecordSection id="recent-denials" title={t("credentials.scans.recentDenials")}>
            <p className="m-0 text-text-13 text-text-secondary">
              {t("credentials.scans.recentDenialsHelp")}
            </p>
            <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
              {recentDenials.map((s) => (
                <li key={s.id} className="flex flex-col gap-8 py-8">
                  <p className="m-0 text-text-13">
                    {joined(
                      s.holderName ?? t("credentials.common.unnamed"),
                      s.credentialNumber,
                      s.zoneCode,
                      dateTime(format, s.scannedAt, timeZone),
                    )}{" "}
                    <ResultChip page={page} scan={s} />
                  </p>
                  <ReportedActionForm
                    action={overrideScanAction}
                    hidden={{ org: page.ctx.org.slug, scanId: s.id }}
                    submitLabel={t("credentials.scans.overrideSubmit")}
                    successKey="credentials.scans.overrideDone"
                    variant="secondary"
                    layout="inline"
                  >
                    <TextField
                      id={`override-${s.id}`}
                      name="reason"
                      label={t("credentials.scans.overrideReason")}
                      help={t("credentials.scans.overrideReasonHelp")}
                      required
                      maxLength={300}
                    />
                  </ReportedActionForm>
                </li>
              ))}
            </ul>
          </RecordSection>
        ) : null}
      </ResultRegion>
      <ScanIntakeQueue page={page} />
      {scans.length === 0 ? (
        <EmptyStateLink
          icon="ScanLine"
          sentence={t(scanResult ? "credentials.scans.emptyFiltered" : "credentials.scans.empty")}
          actionLabel={t("credentials.scans.toIssued")}
          href={
            `/${page.ctx.org.slug}/credentials/issued${page.project ? `?project=${page.project.key}` : ""}` as Route
          }
        />
      ) : view === "list" ? (
        <OpsList
          label={title}
          items={scans.map((s) => ({
            key: s.id,
            href: `/${page.ctx.org.slug}/credentials/issued?project=${s.projectKey}&peek=${s.credentialId}` as Route,
            title: `${s.holderName ?? t("credentials.common.unnamed")} · ${s.zoneCode}`,
            meta: `${s.credentialNumber} · ${dateTime(format, s.scannedAt, timeZone)}`,
            trailing: <ResultChip page={page} scan={s} />,
          }))}
        />
      ) : (
        <OpsTable
          caption={title}
          columns={columns}
          rows={scans}
          rowKey={(s) => s.id}
          rowHref={(s) =>
            `/${page.ctx.org.slug}/credentials/issued?project=${s.projectKey}&peek=${s.credentialId}` as Route
          }
        />
      )}
    </CollectionPage>
  );
}
