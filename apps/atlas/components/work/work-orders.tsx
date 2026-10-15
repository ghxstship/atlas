"use client";

import type { Bid, WorkOrder, WorkOrderStateEntry } from "@xos/data/work-orders";
import type { ProjectRef } from "@xos/data/work";
import {
  Board,
  Button,
  DataTable,
  Drawer,
  EmptyState,
  Input,
  Money,
  PageHeader,
  PropertyList,
  RecordList,
  RecordRow,
  Select,
  StateChip,
  Tag,
  TemplateCollection,
  Textarea,
} from "@xos/ui";
import type { Route } from "next";
import { useFormatter, useLocale } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ActionErrorAlert, useAction, useCopy } from "./action-ui";
import { formatWhen, fromLocalInput, toLocalInput, withQuery, workOrderToken } from "./format";
import {
  addBidAction,
  awardBidAction,
  createWorkOrderAction,
  deleteWorkOrderAction,
  priceBidAction,
  transitionWorkOrderAction,
  updateWorkOrderAction,
  withdrawBidAction,
} from "./work-order-actions";
import { CollectionViews } from "@/components/views/collection-views";

export interface BidderOption {
  readonly organizationId: string;
  readonly name: string;
}

export interface CurrencyOption {
  readonly code: string;
  readonly exponent: number;
}

/** Lowest live priced bid, NULL-aware: unpriced bids never count as zero (Section 3.7). */
function lowestBid(bids: readonly Bid[]): Bid | null {
  return bids
    .filter((b) => !b.withdrawnAt && b.amountMinor !== null)
    .reduce<Bid | null>(
      (low, b) => (low === null || (b.amountMinor ?? 0) < (low.amountMinor ?? 0) ? b : low),
      null,
    );
}

/**
 * Work > Work orders (Section 4.5.5): work orders as a list, table or board by state, with the
 * peek holding bids, the award and the lifecycle. The view, search and state live in the query
 * string; `?peek=<id>` opens the peek and `&full=1` shows it as a full page.
 */
export function WorkOrderCollection({
  org,
  title,
  orders,
  total,
  views,
  view,
  states,
  q,
  state,
  create,
  peek,
  canCreate,
}: {
  org: string;
  title: string;
  orders: readonly WorkOrder[];
  total: number;
  views: readonly string[];
  view: string;
  states: readonly string[];
  q: string;
  state: string;
  create: ReactNode;
  peek: ReactNode;
  canCreate: boolean;
}) {
  const t = useCopy("work");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [search, setSearch] = useState(q);
  const go = (changes: Record<string, string | null>) =>
    router.replace(withQuery(pathname, params, changes) as Route, { scroll: false });
  const open = (id: string) =>
    router.push(withQuery(pathname, params, { peek: id, full: null }) as Route, { scroll: false });
  const stateLabel = (s: string) => t(`workOrders.states.${s}`);
  const header = (
    <PageHeader
      title={title}
      count={orders.length}
      views={
        views.length > 1 ? (
          <CollectionViews
            label={t("collection.views")}
            value={view}
            options={views.map((v) => ({ value: v, label: t(`views.${v}`) }))}
            onChange={(v) => go({ view: v })}
          />
        ) : undefined
      }
      actions={canCreate ? create : undefined}
    />
  );
  const filters = (
    <>
      <form
        role="search"
        className="flex items-end gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: search.trim() || null });
        }}
      >
        <Input
          id="wo-search"
          type="search"
          label={t("collection.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button type="submit">{t("collection.apply")}</Button>
      </form>
      <Select
        key={`state-${state}`}
        id="wo-state"
        label={t("collection.state")}
        value={state}
        options={[
          { value: "", label: t("collection.allStates") },
          ...states.map((s) => ({ value: s, label: stateLabel(s) })),
        ]}
        onChange={(e) => go({ state: e.target.value || null })}
      />
    </>
  );

  let body: ReactNode;
  if (total === 0) {
    body = (
      <EmptyState
        icon="ClipboardList"
        sentence={t("empty.workOrders.sentence")}
        actionLabel={canCreate ? t("empty.workOrders.action") : t("empty.readOnlyAction")}
        onAction={() => (canCreate ? go({ create: "1" }) : router.push(`/${org}/my-work` as Route))}
      />
    );
  } else if (orders.length === 0) {
    body = (
      <EmptyState
        icon="SearchX"
        sentence={t("empty.filtered")}
        actionLabel={t("collection.clear")}
        onAction={() => {
          setSearch("");
          go({ q: null, state: null });
        }}
      />
    );
  } else if (view === "table") {
    body = (
      <DataTable
        caption={title}
        columns={[
          { key: "key", label: t("columns.key"), type: "code" },
          { key: "title", label: t("columns.title"), wrap: true },
          { key: "state", label: t("columns.state"), type: "state" },
          { key: "bids", label: t("columns.bids"), type: "number" },
          { key: "lowest", label: t("columns.lowest") },
          { key: "budget", label: t("columns.budget") },
          { key: "due", label: t("columns.due") },
        ]}
        rows={orders.map((o) => {
          const low = lowestBid(o.bids);
          return {
            id: o.id,
            key: o.key,
            title: o.title,
            state: { state: workOrderToken(o.state), label: stateLabel(o.state) },
            bids: o.bids.filter((b) => !b.withdrawnAt).length,
            lowest: low
              ? formatMoneyText(low.amountMinor, low.currencyCode, locale)
              : t("values.unpriced"),
            budget: formatMoneyText(o.budgetMinor, o.currencyCode, locale) ?? t("values.unpriced"),
            due: formatWhen(o.scheduledEndsAt, locale, o.timeZone) ?? t("values.noDate"),
          };
        })}
        onRowActivate={(row) => open(String(row["id"]))}
      />
    );
  } else if (view === "board") {
    body = (
      <section aria-label={t("workOrders.boardLabel")}>
        <Board
          readOnly
          columns={states.map((s) => ({
            state: workOrderToken(s),
            label: stateLabel(s),
            cards: orders
              .filter((o) => o.state === s)
              .map((o) => ({
                key: o.id,
                title: o.title,
                meta: `${o.key} · ${t("workOrders.summary", summaryValues(o.bids))}`,
              })),
          }))}
          onOpen={open}
        />
      </section>
    );
  } else {
    body = (
      <RecordList label={title}>
        {orders.map((o) => (
          <RecordRow
            key={o.id}
            state={workOrderToken(o.state)}
            stateLabel={stateLabel(o.state)}
            recordKey={o.key}
            title={o.title}
            chips={<Tag>{t("workOrders.summary", summaryValues(o.bids))}</Tag>}
            {...(formatWhen(o.scheduledEndsAt, locale, o.timeZone)
              ? { next: formatWhen(o.scheduledEndsAt, locale, o.timeZone) as string }
              : {})}
            actionLabel={t("collection.open")}
            onAction={() => open(o.id)}
            onOpen={() => open(o.id)}
          />
        ))}
      </RecordList>
    );
  }

  return (
    <TemplateCollection header={header} filters={filters} peek={peek}>
      {body}
    </TemplateCollection>
  );
}

function summaryValues(bids: readonly Bid[]) {
  const live = bids.filter((b) => !b.withdrawnAt);
  return { live: live.length, unpriced: live.filter((b) => b.amountMinor === null).length };
}

/** Money in minor units as text, using the currency's own minor unit; null stays null (Unpriced). */
function formatMoneyText(minor: number | null, currency: string, locale: string): string | null {
  if (minor === null) return null;
  const format = new Intl.NumberFormat(locale, { style: "currency", currency });
  return format.format(minor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
}

/** The New work order sheet. */
export function CreateWorkOrderDialog({
  org,
  projects,
  fixedProjectId,
  currencies,
  open,
}: {
  org: string;
  projects: readonly ProjectRef[];
  fixedProjectId?: string;
  currencies: readonly CurrencyOption[];
  open: boolean;
}) {
  const t = useCopy("work");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { pending, error, run, clear } = useAction();
  const [projectId, setProjectId] = useState(fixedProjectId ?? projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState("");
  const [bidDue, setBidDue] = useState("");
  const [budget, setBudget] = useState("");
  const [currency, setCurrency] = useState("USD");
  const tz = projects.find((p) => p.id === projectId)?.timeZone ?? "UTC";
  const exponent = currencies.find((c) => c.code === currency)?.exponent ?? 2;
  const setOpen = (value: boolean) => {
    clear();
    router.replace(withQuery(pathname, params, { create: value ? "1" : null }) as Route, {
      scroll: false,
    });
  };
  if (projects.length === 0) {
    return (
      <Button
        variant="primary"
        icon="FolderPlus"
        onClick={() => router.push(`/${org}/projects/all?create=1` as Route)}
      >
        {t("create.needProject")}
      </Button>
    );
  }
  return (
    <>
      <Button variant="primary" icon="Plus" onClick={() => setOpen(true)}>
        {t("workOrders.new")}
      </Button>
      {open ? (
        <Drawer
          title={t("workOrders.new")}
          open
          onOpenChange={(v) => (v ? undefined : setOpen(false))}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t("actions.cancel")}
              </Button>
              <Button
                variant="primary"
                loading={pending}
                disabled={title.trim() === "" || projectId === ""}
                onClick={() =>
                  run(
                    () =>
                      createWorkOrderAction(org, projectId, {
                        title,
                        scopeOfWork: scope || null,
                        bidDueAt: fromLocalInput(bidDue, tz),
                        budgetMinor:
                          budget === "" ? null : Math.round(Number(budget) * 10 ** exponent),
                        currencyCode: currency,
                      }),
                    (data) =>
                      router.replace(
                        withQuery(pathname, params, { create: null, peek: data.id }) as Route,
                        { scroll: false },
                      ),
                  )
                }
              >
                {t("workOrders.create")}
              </Button>
            </>
          }
        >
          <ActionErrorAlert error={error} />
          {fixedProjectId || projects.length === 1 ? null : (
            <Select
              id="wo-project"
              label={t("fields.project")}
              value={projectId}
              options={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
              onChange={(e) => setProjectId(e.target.value)}
            />
          )}
          <Input
            id="wo-title"
            label={t("workOrders.title")}
            width="100%"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea
            id="wo-scope"
            label={t("workOrders.scope")}
            help={t("workOrders.scopeHelp")}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          />
          <Input
            id="wo-bid-due"
            type="datetime-local"
            label={t("workOrders.bidDue")}
            help={t("fields.zoneNote", { zone: tz })}
            value={bidDue}
            onChange={(e) => setBidDue(e.target.value)}
          />
          <div className="flex flex-wrap items-end gap-8">
            <Input
              id="wo-budget"
              type="number"
              min={0}
              step="0.01"
              label={t("workOrders.budget")}
              help={t("values.unpriced")}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
            <Select
              id="wo-currency"
              label={t("workOrders.currency")}
              value={currency}
              options={currencies.map((c) => ({ value: c.code, label: c.code }))}
              onChange={(e) => setCurrency(e.target.value)}
            />
          </div>
        </Drawer>
      ) : null}
    </>
  );
}

/**
 * Everything about one work order: details, lifecycle moves, bids with the award, and history.
 * Comments and attachments arrive as children rendered on the server.
 */
export function WorkOrderBody({
  org,
  order,
  history,
  nextStates,
  bidders,
  currencies,
  canWrite,
  canAward,
  meIsCreator,
  children,
}: {
  org: string;
  order: WorkOrder;
  history: readonly WorkOrderStateEntry[];
  nextStates: readonly string[];
  bidders: readonly BidderOption[];
  currencies: readonly CurrencyOption[];
  canWrite: boolean;
  canAward: boolean;
  meIsCreator: boolean;
  children?: ReactNode;
}) {
  const t = useCopy("work");
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tz = order.timeZone;
  const exponent = (code: string) => currencies.find((c) => c.code === code)?.exponent ?? 2;
  const details = useAction();
  const lifecycle = useAction();
  const bidsAction = useAction();
  const [title, setTitle] = useState(order.title);
  const [scope, setScope] = useState(order.scopeOfWork ?? "");
  const [location, setLocation] = useState(order.locationText ?? "");
  const [starts, setStarts] = useState(toLocalInput(order.scheduledStartsAt, tz));
  const [ends, setEnds] = useState(toLocalInput(order.scheduledEndsAt, tz));
  const [hours, setHours] = useState(
    order.estimatedHours === null ? "" : String(order.estimatedHours),
  );
  const [budget, setBudget] = useState(
    order.budgetMinor === null
      ? ""
      : String(order.budgetMinor / 10 ** exponent(order.currencyCode)),
  );
  const [move, setMove] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [bidder, setBidder] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [award, setAward] = useState<Bid | null>(null);
  const [awardReason, setAwardReason] = useState("");
  const editable = canWrite && (order.state === "Draft" || order.state === "Open");
  const biddingOpen = order.state === "Draft" || order.state === "Open";
  const stateLabel = (s: string) => t(`workOrders.states.${s}`);

  return (
    <div className="flex flex-col gap-24">
      <div className="flex flex-wrap items-center gap-8">
        <StateChip state={workOrderToken(order.state)} label={stateLabel(order.state)} />
        <span className="text-text-13 text-text-secondary">
          {t("workOrders.summary", summaryValues(order.bids))}
        </span>
      </div>
      <PropertyList
        items={[
          { label: t("fields.project"), value: `${order.projectKey} · ${order.projectName}` },
          {
            label: t("workOrders.budget"),
            value: (
              <Money
                amount={order.budgetMinor}
                currency={order.currencyCode}
                unpricedLabel={t("values.unpriced")}
              />
            ),
          },
          {
            label: t("workOrders.bidDue"),
            value: formatWhen(order.bidDueAt, locale, tz) ?? t("values.notSet"),
          },
          {
            label: t("workOrders.ends"),
            value: formatWhen(order.scheduledEndsAt, locale, tz) ?? t("values.notSet"),
          },
        ]}
      />

      {canWrite && nextStates.length > 0 ? (
        <section aria-labelledby={`wo-moves-${order.id}`} className="flex flex-col gap-8">
          <h3 id={`wo-moves-${order.id}`} className="m-0 text-label-13 font-semibold">
            {t("transition.title")}
          </h3>
          <ActionErrorAlert error={lifecycle.error} />
          <div className="flex flex-wrap gap-6">
            {nextStates.map((s) => (
              <Button key={s} size="sm" onClick={() => setMove(s)}>
                {t("workOrders.move", { state: stateLabel(s) })}
              </Button>
            ))}
            {order.state === "Draft" ? (
              <Button
                size="sm"
                variant="ghost"
                icon="Trash2"
                onClick={() =>
                  lifecycle.run(
                    () => deleteWorkOrderAction(org, order.id),
                    () =>
                      router.replace(
                        withQuery(pathname, params, { peek: null, full: null }) as Route,
                      ),
                  )
                }
              >
                {t("workOrders.delete")}
              </Button>
            ) : null}
          </div>
          {move ? (
            <form
              className="flex flex-col gap-8"
              onSubmit={(e) => {
                e.preventDefault();
                lifecycle.run(
                  () =>
                    transitionWorkOrderAction(org, {
                      id: order.id,
                      expected: order.state,
                      next: move,
                      reason,
                    }),
                  () => {
                    setMove(null);
                    setReason("");
                  },
                );
              }}
            >
              <Textarea
                id={`wo-reason-${order.id}`}
                label={t("workOrders.moveTitle", { key: order.key, state: stateLabel(move) })}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="flex gap-6">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={reason.trim() === ""}
                  loading={lifecycle.pending}
                >
                  {t("transition.submit")}
                </Button>
                <Button variant="ghost" onClick={() => setMove(null)}>
                  {t("actions.cancel")}
                </Button>
              </div>
            </form>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby={`wo-bids-${order.id}`} className="flex flex-col gap-8">
        <h3 id={`wo-bids-${order.id}`} className="m-0 text-label-13 font-semibold">
          {t("workOrders.bids")}
        </h3>
        <ActionErrorAlert error={bidsAction.error} />
        {canAward && meIsCreator && order.state === "Open" ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("workOrders.creator")}</p>
        ) : null}
        {order.bids.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("workOrders.noBids")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {order.bids.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                <span className="flex flex-col gap-2">
                  <span className="text-text-14 font-medium">
                    {b.bidderName ?? t("values.unnamed")}
                  </span>
                  <span className="text-text-12 text-text-secondary">
                    {t("workOrders.submitted", {
                      date: format.dateTime(new Date(b.submittedAt), { dateStyle: "medium" }),
                    })}
                    {b.note ? ` · ${b.note}` : ""}
                  </span>
                </span>
                <span className="flex items-center gap-8">
                  <Money
                    amount={b.amountMinor}
                    currency={b.currencyCode}
                    unpricedLabel={t("values.unpriced")}
                  />
                  {order.awardedBidId === b.id ? (
                    <Tag tone="success">{t("workOrders.awarded")}</Tag>
                  ) : null}
                  {b.withdrawnAt ? <Tag>{t("workOrders.withdrawn")}</Tag> : null}
                  {canAward && order.state === "Open" && !b.withdrawnAt && !meIsCreator ? (
                    <Button size="sm" variant="primary" onClick={() => setAward(b)}>
                      {t("workOrders.award")}
                    </Button>
                  ) : null}
                  {canWrite && biddingOpen && !b.withdrawnAt && b.amountMinor === null ? (
                    <PriceBid org={org} bid={b} exponent={exponent(b.currencyCode)} />
                  ) : null}
                  {canWrite && biddingOpen && !b.withdrawnAt ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => bidsAction.run(() => withdrawBidAction(org, b.id))}
                    >
                      {t("workOrders.withdraw")}
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {award ? (
          <form
            className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
            onSubmit={(e) => {
              e.preventDefault();
              bidsAction.run(
                () =>
                  awardBidAction(org, {
                    workOrderId: order.id,
                    bidId: award.id,
                    reason: awardReason,
                  }),
                () => setAward(null),
              );
            }}
          >
            <Textarea
              id={`wo-award-${order.id}`}
              label={t("workOrders.awardTitle", {
                key: order.key,
                bidder: award.bidderName ?? t("values.unnamed"),
              })}
              help={t("workOrders.awardReason")}
              value={awardReason}
              onChange={(e) => setAwardReason(e.target.value)}
            />
            <div className="flex gap-6">
              <Button
                type="submit"
                variant="primary"
                disabled={awardReason.trim() === ""}
                loading={bidsAction.pending}
              >
                {t("workOrders.award")}
              </Button>
              <Button variant="ghost" onClick={() => setAward(null)}>
                {t("actions.cancel")}
              </Button>
            </div>
          </form>
        ) : null}
        {canWrite && biddingOpen ? (
          bidders.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("workOrders.noBidders")}</p>
          ) : (
            <form
              className="flex flex-wrap items-end gap-8"
              onSubmit={(e) => {
                e.preventDefault();
                bidsAction.run(
                  () =>
                    addBidAction(org, {
                      workOrderId: order.id,
                      bidderOrganizationId: bidder,
                      amountMinor:
                        amount === ""
                          ? null
                          : Math.round(Number(amount) * 10 ** exponent(order.currencyCode)),
                      currencyCode: order.currencyCode,
                      note: note.trim() || null,
                    }),
                  () => {
                    setAmount("");
                    setNote("");
                  },
                );
              }}
            >
              <Select
                key={order.bids.length}
                id={`wo-bidder-${order.id}`}
                label={t("workOrders.bidder")}
                value=""
                placeholder={t("workOrders.chooseBidder")}
                options={bidders.map((b) => ({ value: b.organizationId, label: b.name }))}
                onChange={(e) => setBidder(e.target.value)}
              />
              <Input
                id={`wo-amount-${order.id}`}
                type="number"
                min={0}
                step="0.01"
                label={t("workOrders.amount")}
                help={t("workOrders.amountHelp")}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <Input
                id={`wo-note-${order.id}`}
                label={t("workOrders.note")}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <Button type="submit" disabled={bidder === ""} loading={bidsAction.pending}>
                {t("workOrders.addBid")}
              </Button>
            </form>
          )
        ) : null}
      </section>

      {editable ? (
        <form
          aria-label={t("edit.title")}
          className="flex flex-col gap-12"
          onSubmit={(e) => {
            e.preventDefault();
            details.run(() =>
              updateWorkOrderAction(org, order.id, {
                title,
                scopeOfWork: scope || null,
                locationText: location || null,
                scheduledStartsAt: fromLocalInput(starts, tz),
                scheduledEndsAt: fromLocalInput(ends, tz),
                estimatedHours: hours === "" ? null : Number(hours),
                budgetMinor:
                  budget === ""
                    ? null
                    : Math.round(Number(budget) * 10 ** exponent(order.currencyCode)),
              }),
            );
          }}
        >
          <h3 className="m-0 text-label-13 font-semibold">{t("edit.title")}</h3>
          <ActionErrorAlert error={details.error} />
          <Input
            id={`wo-edit-title-${order.id}`}
            label={t("workOrders.title")}
            width="100%"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea
            id={`wo-edit-scope-${order.id}`}
            label={t("workOrders.scope")}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-12 max-sm:grid-cols-1">
            <Input
              id={`wo-edit-location-${order.id}`}
              label={t("workOrders.location")}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
            <Input
              id={`wo-edit-hours-${order.id}`}
              type="number"
              min={0}
              label={t("workOrders.hours")}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
            <Input
              id={`wo-edit-starts-${order.id}`}
              type="datetime-local"
              label={t("workOrders.starts")}
              value={starts}
              onChange={(e) => setStarts(e.target.value)}
            />
            <Input
              id={`wo-edit-ends-${order.id}`}
              type="datetime-local"
              label={t("workOrders.ends")}
              value={ends}
              onChange={(e) => setEnds(e.target.value)}
            />
            <Input
              id={`wo-edit-budget-${order.id}`}
              type="number"
              min={0}
              step="0.01"
              label={t("workOrders.budget")}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>
          <div>
            <Button type="submit" loading={details.pending}>
              {t("workOrders.save")}
            </Button>
          </div>
        </form>
      ) : order.scopeOfWork ? (
        <p className="m-0 whitespace-pre-wrap text-text-14">{order.scopeOfWork}</p>
      ) : null}

      <section aria-labelledby={`wo-history-${order.id}`} className="flex flex-col gap-8">
        <h3 id={`wo-history-${order.id}`} className="m-0 text-label-13 font-semibold">
          {t("workOrders.history")}
        </h3>
        <ol className="m-0 flex list-none flex-col gap-6 p-0">
          {history.map((h) => (
            <li key={h.id} className="text-text-13">
              <span className="font-medium">
                {h.from
                  ? t("history.moved", { from: stateLabel(h.from), to: stateLabel(h.to) })
                  : t("history.created", { state: stateLabel(h.to) })}
              </span>{" "}
              <span className="text-text-secondary">
                {format.dateTime(new Date(h.at), { dateStyle: "medium", timeStyle: "short" })}
                {h.byName ? ` · ${h.byName}` : ""}
              </span>
              {h.from ? <p className="m-0 text-text-secondary">{h.reason}</p> : null}
            </li>
          ))}
        </ol>
      </section>
      {children}
    </div>
  );
}

function PriceBid({ org, bid, exponent }: { org: string; bid: Bid; exponent: number }) {
  const t = useCopy("work");
  const { pending, error, run } = useAction();
  const [value, setValue] = useState("");
  return (
    <form
      className="flex items-end gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        run(() =>
          priceBidAction(
            org,
            bid.id,
            value === "" ? null : Math.round(Number(value) * 10 ** exponent),
          ),
        );
      }}
    >
      <Input
        id={`price-${bid.id}`}
        type="number"
        min={0}
        step="0.01"
        width={120}
        label={t("workOrders.amount")}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button type="submit" size="sm" disabled={value === ""} loading={pending}>
        {t("actions.save")}
      </Button>
      <ActionErrorAlert error={error} />
    </form>
  );
}

/** The work order side peek; Open full page keeps the same body at full width. */
export function WorkOrderPeek({ title, children }: { title: string; children: ReactNode }) {
  const t = useCopy("work");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <Drawer
      title={title}
      open
      onOpenChange={(v) => {
        if (!v)
          router.replace(withQuery(pathname, params, { peek: null }) as Route, { scroll: false });
      }}
      footer={
        <Button onClick={() => router.push(withQuery(pathname, params, { full: "1" }) as Route)}>
          {t("workOrders.fullPage")}
        </Button>
      }
    >
      {children}
    </Drawer>
  );
}
