import { readView } from "@xos/data/gateway";
import type { Metadata } from "next";
import { getLocale } from "next-intl/server";
import { PageTitle, RegionError } from "@/components/page/page";
import { DestinationTabs } from "@/components/page/work-tabs";
import { formatDateTime } from "@/lib/format";
import { requireNode } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t("nav.gateway.work.quoteRequests") };
}

/**
 * Work > Quote requests (B11, G-196, ADR 0150): where a quote reminder lands. The Owner and Admin of an invited vendor's
 * account read the Issued RFQs that ask them for a quote, line by line, with no prices, needs or other vendors. It is
 * read-only: the vendor sends the quote to the named contact and the buyer records it.
 */
export default async function QuoteRequestsPage() {
  const ctx = await requireNode("work.quote-requests");
  const t = await getTranslate();
  const locale = await getLocale();
  const [requests, lines] = await Promise.all([
    readView(ctx.db, "rfq_requests", { order: ["responses_due_at", "asc"] }),
    readView(ctx.db, "rfq_request_lines", { order: ["line_number", "asc"] }),
  ]);
  return (
    <>
      <PageTitle title={t("nav.gateway.work.quoteRequests")} />
      <DestinationTabs ctx={ctx} destination="work" active="work.quote-requests" t={t} />
      {!requests.ok || !lines.ok ? (
        <RegionError />
      ) : requests.data.length === 0 ? (
        <p className="m-0 text-text-14 text-text-secondary">
          {t("gateway.work.quoteRequests.empty")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-16 p-0">
          {requests.data.map((r) => (
            <li
              key={r.id}
              className="flex flex-col gap-8 rounded-card border border-border-subtle bg-bg-raised p-16"
            >
              <h2 className="m-0 text-text-16 font-medium">{r.title}</h2>
              <p className="m-0 text-text-13 text-text-secondary">
                {t("gateway.work.quoteRequests.from", {
                  org: r.org_name ?? "",
                  project: r.project_name ?? "",
                })}
              </p>
              <p className="m-0 text-text-13">
                {r.responses_due_at
                  ? t("gateway.work.quoteRequests.due", {
                      when: formatDateTime(locale, r.responses_due_at, r.time_zone),
                    })
                  : t("gateway.work.quoteRequests.noDue")}
              </p>
              <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
                {lines.data
                  .filter((l) => l.rfq_id === r.id)
                  .map((l) => (
                    <li key={l.id}>
                      {l.acquisition_kind === "Rental" && l.hire_from && l.hire_to
                        ? t("gateway.work.quoteRequests.hireLine", {
                            quantity: l.quantity ?? 0,
                            description: l.description ?? "",
                            from: formatDateTime(locale, l.hire_from, r.time_zone),
                            to: formatDateTime(locale, l.hire_to, r.time_zone),
                          })
                        : t("gateway.work.quoteRequests.line", {
                            quantity: l.quantity ?? 0,
                            description: l.description ?? "",
                          })}
                    </li>
                  ))}
              </ul>
              <p className="m-0 text-text-13">
                {r.contact_name
                  ? t("gateway.work.quoteRequests.sendTo", { name: r.contact_name })
                  : t("gateway.work.quoteRequests.sendToOrg", { org: r.org_name ?? "" })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
