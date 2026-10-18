import { FORM_1099_NEC_THRESHOLD_MINOR, listForm1099NecRows } from "@xos/data/form-1099";
import { getNode } from "@xos/ia";
import Link from "next/link";
import type { Route } from "next";
import { withQuery, type FinancePage } from "@/lib/finance/context";
import { getFinanceCopy } from "@/lib/finance/copy";
import { sitemap } from "@/lib/shell/sitemap";
import { FinanceCollection } from "./collection";
import { Form1099ExportForm } from "./forms-form1099-export-form";
import type { Row } from "./kit.types";

/** Tax years offered: the current year and the three before it; the default is last year. */
export function taxYears(today: Date = new Date()): number[] {
  const year = today.getUTCFullYear();
  return [year, year - 1, year - 2, year - 3];
}

/**
 * Finance > Year-end (A43, finding A38-006; Section 4.4.5): the 1099-NEC payees of a tax year, each
 * US independent contractor paid $600 or more in approved USD payments, whether a W-9 and its address
 * are on file, and the file in the IRS FIRE field layout as a Restricted export behind step-up.
 */
export async function YearEndView({ page }: { page: FinancePage }) {
  const { ctx, access, query } = page;
  const c = await getFinanceCopy(ctx);
  const { t } = c;
  const title = t(getNode(sitemap, "finance.year-end").node.label);
  const years = taxYears();
  const asked = Number(query.extra["year"]);
  const year = years.includes(asked) ? asked : (years[1] as number);
  const threshold = c.money(FORM_1099_NEC_THRESHOLD_MINOR, "USD");
  const empty = {
    icon: "FileText",
    sentence: t("finance.yearEnd.empty", { year, threshold }),
    actionLabel: t("finance.yearEnd.emptyAction"),
    noMatches: t("finance.common.noMatches"),
    clearLabel: t("finance.common.clearFilters"),
  };
  const base = { page, title, columns: [], rows: [], count: 0, empty };
  if (!access.can("finance.payment.read")) {
    return <FinanceCollection {...base} canCreate={false} refusal="finance.payment.read" />;
  }
  const rows = await listForm1099NecRows(ctx.viewer.db, { orgId: ctx.org.id, year });
  if (!rows.ok) {
    return <FinanceCollection {...base} canCreate={false} error={t("finance.yearEnd.loadError")} />;
  }
  const term = query.q?.toLowerCase() ?? null;
  const shown = rows.data.filter((r) => term === null || r.payeeName.toLowerCase().includes(term));
  const missingForm = rows.data.filter((r) => !r.w9OnFile).length;
  const missingAddress = rows.data.filter((r) => r.w9OnFile && !r.addressComplete).length;
  const table: Row[] = shown.map((r) => ({
    id: r.payeePersonId ?? r.payeeOrganizationId ?? r.payeeName,
    payee: r.payeeName,
    kind: t(r.payeePersonId ? "finance.yearEnd.kind.person" : "finance.yearEnd.kind.account"),
    form: r.w9OnFile ? t("finance.yearEnd.w9OnFile") : t("finance.yearEnd.w9Missing"),
    tin: r.tinLast4 ? t("finance.yearEnd.tinLast4", { last4: r.tinLast4 }) : "",
    address: r.addressComplete
      ? [r.locality, r.regionCode].filter(Boolean).join(", ")
      : t("finance.yearEnd.addressMissing"),
    payments: c.number(r.paymentCount),
    amount: c.money(r.amountMinor, "USD"),
  }));
  return (
    <FinanceCollection
      {...base}
      canCreate={false}
      count={shown.length}
      above={
        <div className="flex flex-col gap-16">
          <nav
            aria-label={t("finance.yearEnd.yearFilter")}
            className="flex flex-wrap items-center gap-8 text-text-13"
          >
            {years.map((y) => (
              <Link
                key={y}
                href={withQuery(page, { year: String(y) }) as Route}
                aria-current={y === year ? "true" : undefined}
                className="rounded-chip border border-border-subtle px-8 py-2 text-text-12 aria-[current=true]:bg-bg-hover aria-[current=true]:text-text-primary"
              >
                {t("finance.yearEnd.taxYear", { year: y })}
              </Link>
            ))}
          </nav>
          <p className="m-0 text-text-13 text-text-secondary">
            {t("finance.yearEnd.summary", {
              count: rows.data.length,
              threshold,
              missingForm,
              missingAddress,
            })}
          </p>
          {rows.data.length > 0 && access.can("data.export.restricted") ? (
            <Form1099ExportForm org={ctx.org.slug} year={year} />
          ) : rows.data.length > 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {t("finance.yearEnd.exportNeedsCapability")}
            </p>
          ) : null}
        </div>
      }
      columns={[
        { key: "payee", label: t("finance.yearEnd.columns.payee"), wrap: true },
        { key: "kind", label: t("finance.yearEnd.columns.kind") },
        { key: "form", label: t("finance.yearEnd.columns.form") },
        { key: "tin", label: t("finance.yearEnd.columns.tin"), type: "code" },
        { key: "address", label: t("finance.yearEnd.columns.address"), wrap: true },
        { key: "payments", label: t("finance.yearEnd.columns.payments"), type: "number" },
        { key: "amount", label: t("finance.yearEnd.columns.amount"), type: "number" },
      ]}
      rows={table}
      listItems={shown.map((r) => ({
        id: r.payeePersonId ?? r.payeeOrganizationId ?? r.payeeName,
        recordKey: r.tinLast4 ? t("finance.yearEnd.tinLast4", { last4: r.tinLast4 }) : "",
        title: r.payeeName,
        state: r.w9OnFile && r.addressComplete ? ("ready" as const) : ("blocked" as const),
        stateLabel: r.w9OnFile ? t("finance.yearEnd.w9OnFile") : t("finance.yearEnd.w9Missing"),
        next: c.money(r.amountMinor, "USD"),
      }))}
    />
  );
}
