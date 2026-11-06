import type { Route } from "next";
import Link from "next/link";
import { withQuery, type FinancePage } from "@/lib/finance/context";
import { InlineAlert } from "./payables-ui";

/** The sections of Finance > Payments, as `?tab=`; payments is the bare page. */
export const PAYMENT_TABS = [
  "payments",
  "settlements",
  "due",
  "reimbursements",
  "act-costs",
] as const;
export type PaymentTab = (typeof PAYMENT_TABS)[number];

const LABEL_KEY: Readonly<Record<PaymentTab, string>> = {
  payments: "payments",
  settlements: "settlements",
  due: "due",
  reimbursements: "reimbursements",
  "act-costs": "actCosts",
};

export function PaymentTabs({
  page,
  active,
  t,
}: {
  page: FinancePage;
  active: PaymentTab;
  t: (k: string) => string;
}) {
  return (
    <nav
      aria-label={t("finance.payments.tabs")}
      className="flex gap-8 overflow-x-auto border-b border-border-subtle text-text-13"
    >
      {PAYMENT_TABS.map((tab) => (
        <Link
          key={tab}
          href={
            withQuery(page, {
              tab: tab === "payments" ? null : tab,
              peek: null,
              state: null,
              payee: null,
              record: null,
              currency: null,
              notice: null,
              voidReimbursement: null,
              payPerDiems: null,
            }) as Route
          }
          aria-current={active === tab ? "page" : undefined}
          className="-mb-px border-b-2 border-transparent px-4 py-6 whitespace-nowrap text-text-secondary aria-[current=page]:border-accent aria-[current=page]:text-text-primary"
        >
          {t(`finance.payments.tab.${LABEL_KEY[tab]}`)}
        </Link>
      ))}
    </nav>
  );
}

const NOTICES = new Set(["reimbursementRecorded", "reimbursementVoided", "perDiemsPaid"]);

/**
 * What a recording did, at page level. The row that leaves the list after recording cannot carry its own
 * confirmation, so the sheet returns here with `?notice=`, which survives the refresh that removes the row.
 */
export function PaymentsNotice({ page, t }: { page: FinancePage; t: (k: string) => string }) {
  const notice = page.query.extra["notice"];
  if (!notice || !NOTICES.has(notice)) return null;
  return <InlineAlert tone="success">{t(`finance.payments.notice.${notice}`)}</InlineAlert>;
}
