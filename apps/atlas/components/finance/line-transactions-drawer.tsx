"use client";

import type { LineTransactions } from "@xos/data/budget-transactions";
import { Button, Drawer } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { loadLineTransactionsAction } from "@/app/[org]/finance/quote-actions";
import { useFinanceT } from "./kit-use-finance-t";

/**
 * What stands behind a line's Actual and Committed (G-210, ADR 0152). Actual = Expenses + Labor, and
 * each subtotal equals the figure it explains; a section the viewer cannot read says so and never
 * shows a partial list. Vendor invoices post to the ledger, so they stand apart from Actual.
 */
export function LineTransactionsDrawer({
  org,
  lineId,
  currency,
  exponent,
  access,
  onClose,
}: {
  org: string;
  lineId: string;
  currency: string;
  exponent: number;
  access: {
    readonly expenses: boolean;
    readonly labor: boolean;
    readonly purchaseOrders: boolean;
    readonly invoices: boolean;
  };
  onClose: () => void;
}) {
  const t = useFinanceT();
  const [data, setData] = useState<LineTransactions | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();
  useEffect(() => {
    start(async () => {
      const result = await loadLineTransactionsAction(org, lineId, access, currency);
      if (result.ok) setData(result.transactions);
      else setFailed(true);
    });
    // access is fixed for the page; a new line reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, lineId]);
  const money = (minor: number | null) =>
    minor === null
      ? t("common.unpriced")
      : new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
          minor / 10 ** exponent,
        );
  const unpricedHours = data ? Math.round((data.laborUnpricedMinutes / 60) * 100) / 100 : 0;
  return (
    <Drawer
      open
      onClose={onClose}
      title={t("budgets.transactions.title")}
      footer={<Button onClick={onClose}>{t("common.close")}</Button>}
    >
      {failed ? (
        <p role="alert" className="m-0 text-text-13 text-danger-text">
          {t("budgets.transactions.loadError")}
        </p>
      ) : null}
      {pending && !data ? (
        <p role="status" className="m-0 text-text-13 text-text-secondary">
          {t("common.loading")}
        </p>
      ) : null}
      {data ? (
        <div className="flex flex-col gap-16">
          <Block
            title={t("budgets.transactions.expenses")}
            subtotal={data.expenses ? money(data.expenseTotalMinor) : null}
            withheld={data.expenses === null}
            withheldCopy={t("budgets.transactions.withheld")}
          >
            {data.expenses?.map((e) => (
              <Row
                key={e.id}
                main={
                  <Link
                    className="text-accent-text underline"
                    href={`/${org}/finance/expenses?peek=${e.id}` as Route}
                  >
                    {e.description}
                  </Link>
                }
                meta={[e.incurredOn, e.submitter].filter(Boolean).join(" · ")}
                amount={money(e.amountMinor)}
              />
            ))}
          </Block>
          <Block
            title={t("budgets.transactions.labor")}
            subtotal={money(data.laborActualMinor)}
            withheld={false}
            withheldCopy=""
          >
            {unpricedHours > 0 ? (
              <p className="m-0 text-text-12 text-warning-text">
                {t("budgets.unpricedHours", { hours: unpricedHours })}
              </p>
            ) : null}
            {data.laborRows?.map((l) => (
              <Row
                key={l.postingId}
                main={l.person ?? t(`budgets.transactions.teams.${l.teamKind.replace(" ", "")}`)}
                meta={[
                  l.workDate,
                  l.teamName,
                  l.segment,
                  `${Math.round((l.minutes / 60) * 100) / 100} h`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                amount={
                  l.isUnpriced
                    ? t("common.unpriced")
                    : l.isMasked
                      ? t("budgets.transactions.restricted")
                      : money(l.amountMinor)
                }
              />
            ))}
          </Block>
          <Block
            title={t("budgets.transactions.committed")}
            subtotal={data.committed ? money(data.committedMinor) : null}
            withheld={data.committed === null}
            withheldCopy={t("budgets.committedWithheld")}
          >
            {data.committed?.map((c) => (
              <Row
                key={c.id}
                main={
                  <Link
                    className="text-accent-text underline"
                    href={`/${org}/procurement/purchase-orders?peek=${c.purchaseOrderId}` as Route}
                  >
                    {c.poKey ?? c.description}
                  </Link>
                }
                meta={[c.vendor, c.description].filter(Boolean).join(" · ")}
                amount={money(c.amountMinor)}
              />
            ))}
          </Block>
          <Block
            title={t("budgets.transactions.invoices")}
            subtotal={data.invoices ? money(data.invoiceTotalMinor) : null}
            withheld={data.invoices === null}
            withheldCopy={t("budgets.transactions.withheld")}
          >
            <p className="m-0 text-text-12 text-text-secondary">
              {t("budgets.transactions.invoicesNote")}
            </p>
            {data.invoices?.map((i) => (
              <Row
                key={i.id}
                main={
                  <Link
                    className="text-accent-text underline"
                    href={`/${org}/finance/invoices?peek=${i.invoiceId}` as Route}
                  >
                    {i.invoiceNumber ?? i.description ?? ""}
                  </Link>
                }
                meta={i.description ?? ""}
                amount={money(i.amountMinor)}
              />
            ))}
          </Block>
        </div>
      ) : null}
    </Drawer>
  );
}

function Block({
  title,
  subtotal,
  withheld,
  withheldCopy,
  children,
}: {
  title: string;
  subtotal: string | null;
  withheld: boolean;
  withheldCopy: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-6">
      <h3 className="m-0 flex items-baseline justify-between gap-8 text-text-14 font-medium">
        <span>{title}</span>
        {subtotal ? <span className="tabular-nums">{subtotal}</span> : null}
      </h3>
      {withheld ? <p className="m-0 text-text-12 text-text-secondary">{withheldCopy}</p> : children}
    </section>
  );
}

function Row({ main, meta, amount }: { main: ReactNode; meta: string; amount: string }) {
  return (
    <div className="flex items-center justify-between gap-12 border-t border-border-subtle py-6 text-text-13">
      <span className="flex min-w-0 flex-col">
        <span>{main}</span>
        <span className="text-text-12 text-text-secondary">{meta}</span>
      </span>
      <span className="tabular-nums">{amount}</span>
    </div>
  );
}
