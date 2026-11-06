import type { EngagementRef } from "@xos/data/settlements";
import {
  listLinkableBills,
  listPoInstalments,
  listPurchaseOrderDuplicates,
  type PoLine,
  type PurchaseOrder,
} from "@xos/data/procurement";
import { todayIn } from "@xos/data/calendar";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import {
  addPoInstalmentAction,
  linkPoBillAction,
  removePoInstalmentAction,
  setPoLineActAction,
} from "@/app/[org]/procurement/actions";
import { ActionButton, EntityForm, FormDrawer, KitSection } from "@/components/collection-kit/kit";
import { DataTable } from "@/components/platform/client/data-table";
import { InlineAlert } from "@/components/finance/payables-ui";
import type { Copy } from "@/lib/collection-kit/i18n";
import type { OrgContext } from "@/lib/shell/context";

const REFUSALS = "procurement.refusals";

/**
 * A purchase order's payment schedule (G-195, 6543): numbered instalments such as a deposit and a balance, with their
 * bills and what was paid against them. Each instalment is due on a date; nothing here moves money (decision 20). What
 * may change follows the guard: a Closed order still links a bill to an unbilled instalment or removes one, and a
 * Canceled order changes nothing.
 */
export async function PoPaymentSchedule({
  ctx,
  order,
  t,
  money,
  canWrite,
  zone,
}: {
  ctx: OrgContext;
  order: PurchaseOrder;
  t: Copy;
  money: (minor: number | null, currency: string) => string;
  canWrite: boolean;
  zone: string;
}) {
  const db = ctx.viewer.db;
  const [schedule, format] = await Promise.all([listPoInstalments(db, order.id), getFormatter()]);
  if (!schedule.ok) return null;
  const canLink =
    canWrite && order.state !== "Canceled" && ctx.capabilities.has("finance.invoice.read");
  const bills = canLink ? await listLinkableBills(db, order) : null;
  const linkable = bills?.ok ? bills.data : [];
  const rows = schedule.data;
  const first = rows[0];
  const scheduled = first?.scheduleTotalMinor ?? 0;
  const total = first?.orderTotalMinor ?? null;
  const over = total !== null && scheduled > total;
  const canAdd = canWrite && order.state !== "Closed" && order.state !== "Canceled";
  const canRemove = canWrite && order.state !== "Canceled";
  const paid = (minor: number | null, withheld: boolean) =>
    withheld ? t("schedule.withheld") : money(minor, order.currencyCode);
  return (
    <KitSection id="po-payment-schedule" title={t("schedule.title")}>
      {rows.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("schedule.empty")}</p>
      ) : (
        <DataTable
          caption={t("schedule.title")}
          columns={[
            { key: "n", label: "#", type: "number" },
            { key: "label", label: t("schedule.label"), wrap: true },
            { key: "due", label: t("schedule.due") },
            { key: "amount", label: t("schedule.amount") },
            { key: "bill", label: t("schedule.bill") },
            { key: "paid", label: t("schedule.paid") },
            { key: "status", label: t("schedule.statusLabel") },
          ]}
          rows={rows.map((i) => ({
            n: i.number,
            label: i.label,
            // A day, not an instant: read at noon in UTC so no zone moves it.
            due: format.dateTime(new Date(`${i.dueOn}T12:00:00Z`), {
              dateStyle: "medium",
              timeZone: "UTC",
            }),
            amount: money(i.amountMinor, order.currencyCode),
            bill: i.invoiceId
              ? i.isInvoiceWithheld
                ? t("schedule.withheld")
                : (i.invoiceNumber ?? t("schedule.unnumbered"))
              : "",
            paid: i.invoiceId ? paid(i.paidMinor, i.isPaymentWithheld) : "",
            status: t(`schedule.status.${i.status.replace(/\s+/g, "")}`),
          }))}
          totals={{
            label: t("schedule.scheduled"),
            amount: money(scheduled, order.currencyCode),
          }}
        />
      )}
      {rows.length > 0 ? (
        <dl className="m-0 grid grid-cols-3 gap-12 text-text-13 max-sm:grid-cols-1">
          <div>
            <dt className="text-text-12 text-text-secondary">{t("schedule.scheduled")}</dt>
            <dd className="m-0 tabular-nums">{money(scheduled, order.currencyCode)}</dd>
          </div>
          <div>
            <dt className="text-text-12 text-text-secondary">{t("schedule.orderTotal")}</dt>
            <dd className="m-0 tabular-nums">{money(total, order.currencyCode)}</dd>
          </div>
          <div>
            <dt className="text-text-12 text-text-secondary">{t("schedule.unscheduled")}</dt>
            <dd className="m-0 tabular-nums">
              {money(total === null ? null : total - scheduled, order.currencyCode)}
            </dd>
          </div>
        </dl>
      ) : null}
      {over ? <InlineAlert tone="warning">{t("schedule.over")}</InlineAlert> : null}
      {canRemove || canLink ? (
        <div className="flex flex-wrap gap-8">
          {rows
            .filter((i) => !i.invoiceId)
            .flatMap((i) => [
              ...(canRemove
                ? [
                    <ActionButton
                      key={`remove-${i.id}`}
                      action={removePoInstalmentAction}
                      hidden={{ org: ctx.org.slug, id: i.id }}
                      label={t("schedule.remove", { n: i.number })}
                      refusals={REFUSALS}
                    />,
                  ]
                : []),
              ...(canLink && linkable.length > 0
                ? [
                    <ActionButton
                      key={`link-${i.id}`}
                      action={linkPoBillAction}
                      hidden={{ org: ctx.org.slug, id: i.id }}
                      label={t("schedule.link", { n: i.number })}
                      refusals={REFUSALS}
                      extraFields={[
                        {
                          kind: "select",
                          name: "invoiceId",
                          label: t("schedule.bill"),
                          required: true,
                          options: linkable.map((b) => ({
                            value: b.id,
                            label: b.number ?? t("schedule.unnumbered"),
                          })),
                        },
                      ]}
                    />,
                  ]
                : []),
            ])}
        </div>
      ) : null}
      {canAdd ? (
        <EntityForm
          id={`po-instalment-${order.id}`}
          action={addPoInstalmentAction}
          hidden={{
            org: ctx.org.slug,
            purchaseOrderId: order.id,
            currencyCode: order.currencyCode,
          }}
          refusals={REFUSALS}
          submitVariant="secondary"
          submitLabel={t("schedule.add")}
          fields={[
            { kind: "text", name: "label", label: t("schedule.label"), required: true },
            {
              kind: "date",
              name: "dueOn",
              label: t("schedule.due"),
              required: true,
              defaultValue: todayIn(zone),
            },
            {
              kind: "money",
              name: "amount",
              label: t("schedule.amount"),
              unit: order.currencyCode,
              required: true,
            },
          ]}
        />
      ) : null}
    </KitSection>
  );
}

/**
 * The look-alike warning on a Proposed, Approved or Sent order (G-224): other orders of an alike vendor within 1% of its
 * total, created within 30 days. It blocks nothing.
 */
export async function PoLookAlikes({
  ctx,
  order,
  t,
  hrefFor,
}: {
  ctx: OrgContext;
  order: PurchaseOrder;
  t: Copy;
  hrefFor: (id: string) => string;
}) {
  if (!["Proposed", "Approved", "Sent"].includes(order.state)) return null;
  const found = await listPurchaseOrderDuplicates(ctx.viewer.db, order.id);
  if (!found.ok || found.data.length === 0) return null;
  return (
    <KitSection id="po-look-alikes" title={t("schedule.lookAlike.title")}>
      <InlineAlert tone="warning">
        <span className="flex flex-col gap-4">
          <span>{t("schedule.lookAlike.body", { count: found.data.length })}</span>
          <span className="flex flex-wrap gap-8">
            {found.data.map((d, index) => (
              <Link
                key={d.candidateId}
                href={hrefFor(d.candidateId) as Route}
                className="text-accent-text underline"
              >
                {t("schedule.lookAlike.open", { n: index + 1 })}
              </Link>
            ))}
          </span>
        </span>
      </InlineAlert>
    </KitSection>
  );
}

/** The one-field sheet that names the act a line is bought for (6547), usable on Approved and Sent orders. */
export function PoLineActSheet({
  ctx,
  line,
  engagements,
  t,
  partyName,
  closeHref,
}: {
  ctx: OrgContext;
  line: PoLine;
  engagements: readonly EngagementRef[];
  t: Copy;
  partyName: (e: EngagementRef) => string;
  closeHref: string;
}) {
  return (
    <FormDrawer title={t("schedule.lineAct.title", { n: line.lineNumber })} closeHref={closeHref}>
      <EntityForm
        id={`po-line-act-${line.id}`}
        action={setPoLineActAction}
        hidden={{ org: ctx.org.slug, id: line.id }}
        refusals={REFUSALS}
        submitLabel={t("schedule.lineAct.save")}
        successHref={closeHref}
        fields={[
          {
            kind: "select",
            name: "engagementId",
            label: t("schedule.lineAct.field"),
            blankLabel: t("schedule.lineAct.none"),
            defaultValue: line.engagementId ?? "",
            options: engagements
              .filter((e) => e.state !== "Canceled")
              .map((e) => ({ value: e.id, label: partyName(e) })),
          },
        ]}
      />
    </FormDrawer>
  );
}
