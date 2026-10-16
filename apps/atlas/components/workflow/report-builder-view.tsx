import { getReportDefinition, type ReportDefinition } from "@xos/data/report-builder";
import { listMyRuns, listSavedReports } from "@xos/data/reports";
import type { Route } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { PageHeader, TemplateCollection } from "@/components/finance/ui";
import { InlineAlert } from "@/components/ui";
import { getExponents } from "@/lib/finance/money";
import type { OrgContext } from "@/lib/shell/context";
import { ErrorPanel, RefusalPanel } from "./kit";
import { ReportBuilder } from "./report-builder";

/**
 * Reports > Saved reports > Builder (Section 4.6.4, A33 on A18's report definitions and runs, 0550):
 * build or edit a report and preview it as the viewer; save it, share it and queue runs. The list of
 * reports the viewer may open sits beside the builder, with their latest runs.
 */
export async function ReportBuilderView({
  ctx,
  reportId,
}: {
  ctx: OrgContext;
  reportId: string | null;
}) {
  const t = (await getTranslations("workflow")) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const org = ctx.org.slug;
  const title = t("builder.title");
  if (!ctx.capabilities.has("reports.report.read")) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <RefusalPanel capability="reports.report.read" href={`/${org}/home`} />
      </TemplateCollection>
    );
  }
  const db = ctx.viewer.db;
  const [reports, runs, exponents] = await Promise.all([
    listSavedReports(db, { orgId: ctx.org.id, membershipId: ctx.org.membershipId }),
    listMyRuns(db, { orgId: ctx.org.id, membershipId: ctx.org.membershipId }),
    getExponents(ctx),
  ]);
  let initial: ReportDefinition | null = null;
  let missing = false;
  if (reportId) {
    const found = await getReportDefinition(db, {
      id: reportId,
      membershipId: ctx.org.membershipId,
    });
    if (found.ok) initial = found.data;
    else if (found.error.kind === "not-found") missing = true;
    else {
      return (
        <TemplateCollection header={<PageHeader title={title} />}>
          <ErrorPanel sentence={t("builder.loadError")} />
        </TemplateCollection>
      );
    }
  }
  if (!reports.ok || !runs.ok) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <ErrorPanel sentence={t("builder.loadError")} />
      </TemplateCollection>
    );
  }
  const canWrite = ctx.capabilities.has("reports.report.write");
  const editable = canWrite && (initial === null || initial.mine);
  const locale = await getLocale();
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );
  const recent = initial
    ? runs.data.filter((r) => r.reportDefinitionId === initial.id).slice(0, 5)
    : [];

  return (
    <TemplateCollection
      header={
        <PageHeader
          title={initial ? initial.name : title}
          actions={
            initial ? (
              <Link
                href={`/${org}/reports/builder` as Route}
                className="inline-flex h-control-md items-center rounded-control border border-border-default px-12 text-text-13 font-medium"
              >
                {t("builder.new")}
              </Link>
            ) : undefined
          }
        />
      }
    >
      <div className="flex flex-col gap-24">
        {missing ? <InlineAlert tone="warning">{t("builder.missing")}</InlineAlert> : null}
        {!canWrite ? <InlineAlert tone="info">{t("builder.readOnly")}</InlineAlert> : null}
        {initial && !initial.mine ? (
          <InlineAlert tone="info">{t("builder.sharedReadOnly")}</InlineAlert>
        ) : null}
        <ReportBuilder
          key={initial?.id ?? "new"}
          org={org}
          initial={initial}
          editable={editable}
          canExport={ctx.capabilities.has("reports.report.export")}
          exponents={Object.fromEntries(exponents)}
        />
        {initial ? (
          <section aria-labelledby="builder-runs" className="flex flex-col gap-8">
            <h2 id="builder-runs" className="m-0 text-heading-16 font-semibold">
              {t("builder.runs.title")}
            </h2>
            {recent.length === 0 ? (
              <p className="m-0 text-text-13 text-text-secondary">{t("builder.runs.none")}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
                {recent.map((r) => (
                  <li key={r.id}>
                    {t("builder.runs.line", {
                      when: when(r.createdAt),
                      format: r.format,
                      status: t(`builder.runs.status.${r.status}`),
                    })}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
        <section aria-labelledby="builder-saved" className="flex flex-col gap-8">
          <h2 id="builder-saved" className="m-0 text-heading-16 font-semibold">
            {t("builder.savedTitle")}
          </h2>
          {reports.data.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("builder.savedNone")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-4 p-0">
              {reports.data.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/${org}/reports/builder?report=${r.id}` as Route}
                    aria-current={r.id === initial?.id ? "page" : undefined}
                    className="text-text-13 font-medium text-accent-text underline"
                  >
                    {r.name}
                  </Link>{" "}
                  <span className="text-text-12 text-text-secondary">
                    {t(`builder.sources.${r.sourceCode}`)} ·{" "}
                    {r.shared ? t("builder.sharedLabel") : t("builder.privateLabel")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </TemplateCollection>
  );
}
