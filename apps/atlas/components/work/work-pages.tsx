import { listAttachments } from "@xos/data/attachments";
import { listThreads } from "@xos/data/comments";
import { Constants } from "@xos/data/database.types";
import {
  getWorkOrder,
  listBidderOptions,
  listPunchItems,
  listWorkOrderHistory,
  listWorkOrders,
  listWorkOrderTransitions,
} from "@xos/data/work-orders";
import {
  listCurrencyOptions,
  listRecurringRecords,
  occurrences,
  type ProjectRef,
} from "@xos/data/work";
import { getNode } from "@xos/ia";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import type { BulkConfig } from "@/components/bulk/types";
import { collectionPeek } from "@/components/shell/collection-peek";
import { PeekHandoff } from "@/components/shell/peek-handoff";
import type { OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";
import { orgToday } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";
import { CollabPanels } from "./collab";
import { formatWhen } from "./format";
import {
  capabilitySet,
  listParam,
  loadRecordMeta,
  must,
  nodeViews,
  param,
  recordBulkConfig,
  type SearchParams,
} from "./load";
import { PunchCollection } from "./punch";
import { RecurringCollection } from "./recurring";
import { loadRecordDetail, RecordBody, recordPropertyItems } from "./record-detail";
import { RecordPeek } from "./record-peek";
import {
  CreateWorkOrderDialog,
  WorkOrderBody,
  WorkOrderCollection,
  WorkOrderPeek,
} from "./work-orders";
import { TemplateRecord } from "./ui";
import { describeRrule } from "@/lib/work/recurrence-text";

const WORK_ORDER_STATES = Constants.app.Enums.work_order_state;

/** Work > Work orders, and work orders inside a project. */
export async function WorkOrdersPage({
  ctx,
  node,
  search,
  project,
}: {
  ctx: OrgContext;
  node: string;
  search: SearchParams;
  project?: ProjectRef;
}) {
  const t = await getTranslate();
  const db = ctx.viewer.db;
  const { views, defaultView } = nodeViews(node);
  const requested = param(search, "view");
  const view = requested && views.includes(requested) ? requested : defaultView;
  const q = param(search, "q") ?? "";
  const state = param(search, "state") ?? "";
  const [meta, caps, all, filtered, rules, bidders, currencies] = await Promise.all([
    loadRecordMeta(ctx),
    capabilitySet(ctx),
    listWorkOrders(db, { orgId: ctx.org.id, ...(project ? { projectId: project.id } : {}) }),
    listWorkOrders(db, {
      orgId: ctx.org.id,
      ...(project ? { projectId: project.id } : {}),
      ...(state ? { states: [state] } : {}),
      ...(q ? { search: q } : {}),
    }),
    listWorkOrderTransitions(db),
    listBidderOptions(db, ctx.org.id),
    listCurrencyOptions(db),
  ]);
  const orders = must(filtered, "work orders");
  const title = t(getNode(sitemap, node).node.label);
  // Bulk edit (Section 11.7): state across a selection, every move but the award, which names a
  // bid. A work order in a state it cannot leave that way (Complete, Canceled) offers no change.
  const movable = new Set(
    must(rules, "work order transitions")
      .filter((r) => r.to !== "Awarded")
      .map((r) => r.from),
  );
  const bulk: BulkConfig | null = caps.has("work.work_order.write")
    ? {
        org: ctx.org.slug,
        resource: "work_orders",
        fields: [
          {
            key: "work_order_state",
            label: t("work.columns.state"),
            reason: true,
            options: WORK_ORDER_STATES.filter((s) => s !== "Awarded").map((s) => ({
              value: s,
              label: t(`work.workOrders.states.${s}`),
            })),
            rows: orders.filter((o) => movable.has(o.state)).map((o) => o.id),
          },
        ],
      }
    : null;

  let peek: ReactNode = null;
  let full: ReactNode = null;
  const peekId = param(search, "peek");
  if (peekId && /^[0-9a-f-]{36}$/.test(peekId)) {
    const order = await getWorkOrder(db, peekId);
    if (order.ok) {
      const subject = { table: "app.work_orders" as const, id: order.data.id };
      const [history, threads, attachments] = await Promise.all([
        listWorkOrderHistory(db, order.data.id),
        listThreads(db, subject),
        listAttachments(db, subject),
      ]);
      const names = Object.fromEntries(
        meta.people.map((p) => [p.personId, p.name ?? t("work.values.unnamed")]),
      );
      const me = ctx.viewer.person?.id ?? null;
      const body = (
        <WorkOrderBody
          org={ctx.org.slug}
          order={order.data}
          history={must(history, "work order history")}
          nextStates={must(rules, "work order transitions")
            .filter((r) => r.from === order.data.state && r.to !== "Awarded")
            .map((r) => r.to)}
          bidders={must(bidders, "bidders")}
          currencies={must(currencies, "currencies")}
          canWrite={caps.has("work.work_order.write")}
          canAward={caps.has("work.work_order.award")}
          meIsCreator={order.data.createdBy !== null && order.data.createdBy === me}
        >
          <CollabPanels
            org={ctx.org.slug}
            subject={subject}
            threads={must(threads, "comments")}
            attachments={must(attachments, "attachments")}
            names={names}
            me={me}
            canPost
          />
        </WorkOrderBody>
      );
      const heading = `${order.data.key} ${order.data.title}`;
      if (param(search, "full") === "1") {
        full = (
          <TemplateRecord
            header={<h1 className="m-0 text-heading-24 font-semibold">{heading}</h1>}
            properties={null}
          >
            {body}
          </TemplateRecord>
        );
      } else {
        peek = <WorkOrderPeek title={heading}>{body}</WorkOrderPeek>;
      }
    }
  }
  if (full) return full;

  return (
    <WorkOrderCollection
      org={ctx.org.slug}
      title={title}
      orders={orders}
      total={must(all, "work orders").length}
      views={views}
      view={view}
      states={WORK_ORDER_STATES}
      q={q}
      state={state}
      canCreate={caps.has("work.work_order.write")}
      bulk={bulk}
      peekedId={peek && peekId ? peekId : null}
      create={
        <CreateWorkOrderDialog
          org={ctx.org.slug}
          projects={meta.projects}
          {...(project ? { fixedProjectId: project.id } : {})}
          currencies={must(currencies, "currencies")}
          open={param(search, "create") === "1"}
        />
      }
      peek={collectionPeek(peekId, peek)}
    />
  );
}

/**
 * The record peek for `?peek=KEY` on pages whose rows are records; a key that names no record the
 * viewer can read goes to the shell's peek.
 */
async function recordPeek(ctx: OrgContext, search: SearchParams): Promise<ReactNode> {
  const key = param(search, "peek");
  if (!key) return null;
  const detail = await loadRecordDetail(ctx, key);
  if (!detail) return <PeekHandoff recordKey={key} />;
  return (
    <RecordPeek
      org={ctx.org.slug}
      recordKey={detail.record.key}
      kind={detail.record.kind}
      title={detail.record.title}
      state={detail.record.state}
      properties={await recordPropertyItems(detail)}
    >
      <RecordBody org={ctx.org.slug} detail={detail} me={ctx.viewer.person?.id ?? null} />
    </RecordPeek>
  );
}

/** Work > Punch lists: punch items with their Task records. */
export async function PunchListsPage({
  ctx,
  node,
  search,
}: {
  ctx: OrgContext;
  node: string;
  search: SearchParams;
}) {
  const t = await getTranslate();
  const { views, defaultView } = nodeViews(node);
  // Site plan needs pins on a drawing; offered only when an item carries one (Section 11.15).
  const db = ctx.viewer.db;
  const states = listParam(search, "state");
  const [meta, caps, all, filtered] = await Promise.all([
    loadRecordMeta(ctx),
    capabilitySet(ctx),
    listPunchItems(db, { orgId: ctx.org.id }),
    listPunchItems(db, { orgId: ctx.org.id, ...(states.length > 0 ? { states } : {}) }),
  ]);
  const items = must(filtered, "punch items");
  const allItems = must(all, "punch items");
  const offered = views.filter(
    (v) => v !== "site-plan" || allItems.some((i) => i.sitePlanPinId !== null),
  );
  const requested = param(search, "view");
  const view =
    requested && offered.includes(requested)
      ? requested
      : offered.includes(defaultView)
        ? defaultView
        : (offered[0] ?? "list");
  // Bulk edit (Section 11.7): an item's state and owner across a selection, on its record. Blocked
  // and Deferred need a blocker or a reason per item, so they stay single edits, and an item whose
  // record cannot move (Canceled) offers no state change.
  const movable = new Set(
    meta.rules.filter((r) => r.to !== "Blocked" && r.to !== "Deferred").map((r) => r.from),
  );
  const bulk: BulkConfig | null = caps.has("work.punch_list.write")
    ? {
        org: ctx.org.slug,
        resource: "punch_items",
        fields: [
          {
            key: "record_state",
            label: t("work.columns.state"),
            reason: true,
            options: meta.states
              .filter((s) => s.state !== "Blocked" && s.state !== "Deferred")
              .map((s) => ({ value: s.state, label: t(`work.states.${s.state}`) })),
            rows: items.filter((i) => movable.has(i.record.state)).map((i) => i.id),
          },
          {
            key: "owner_party_id",
            label: t("work.columns.owner"),
            options: [
              { value: null, label: t("work.values.unassigned") },
              ...meta.people.map((p) => ({ value: p.personId, label: p.name ?? p.personId })),
            ],
          },
        ],
      }
    : null;
  return (
    <PunchCollection
      org={ctx.org.slug}
      title={t(getNode(sitemap, node).node.label)}
      items={items}
      total={allItems.length}
      views={offered}
      view={view}
      states={meta.states}
      state={states[0] ?? ""}
      projects={meta.projects}
      people={meta.people}
      canCreate={caps.has("work.punch_list.write")}
      bulk={bulk}
      open={param(search, "create") === "1"}
      peek={await recordPeek(ctx, search)}
    />
  );
}

/** Work > Recurring: records that repeat, with their rule and next occurrences. */
export async function RecurringPage({
  ctx,
  node,
  search,
}: {
  ctx: OrgContext;
  node: string;
  search: SearchParams;
}) {
  const t = await getTranslate();
  const locale = await getLocale();
  const { views, defaultView } = nodeViews(node);
  const requested = param(search, "view");
  const view = requested && views.includes(requested) ? requested : defaultView;
  // Recurring work is the org's: this month on its calendar, not UTC's (A71).
  const today = await orgToday(ctx);
  const monthParam = param(search, "month");
  const month =
    monthParam && /^\d{4}-\d{2}-01$/.test(monthParam) ? monthParam : `${today.slice(0, 7)}-01`;
  const [meta, caps, listed] = await Promise.all([
    loadRecordMeta(ctx),
    capabilitySet(ctx),
    listRecurringRecords(ctx.viewer.db, { orgId: ctx.org.id }),
  ]);
  const rows = must(listed, "recurring records");
  const items = rows.map(({ record, recurrence }) => {
    const first = record.startsAt ?? record.dueAt ?? record.endsAt;
    const next = first ? occurrences(first, recurrence.rrule, 60, recurrence.untilAt) : [];
    const tz = recurrence.timeZone;
    return {
      record,
      rule: describeRrule(recurrence.rrule, (key, values) => t(`work.recurrence.${key}`, values)),
      timeZone: tz,
      next: next.map((at) => ({ at, label: formatWhen(at, locale, tz) ?? at })),
    };
  });
  return (
    <RecurringCollection
      org={ctx.org.slug}
      title={t(getNode(sitemap, node).node.label)}
      items={items}
      views={views}
      view={view}
      month={month}
      today={today}
      bulk={caps.has("work.record.write") ? recordBulkConfig(ctx.org.slug, meta, t) : null}
      peek={await recordPeek(ctx, search)}
    />
  );
}
