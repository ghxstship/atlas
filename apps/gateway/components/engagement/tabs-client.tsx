import {
  listEngagementDocuments,
  listSharedRecords,
  readView,
  recordDate,
  type RecordKind,
} from "@xos/data/gateway";
import { RegionError, Section } from "@/components/page/page";
import { Calendar } from "@/components/ui";
import { hasArea, tabHref } from "@/lib/engagement";
import { formatDate, formatDateTime, formatMoney, formatScheduleTime } from "@/lib/format";
import { enumLabelKey } from "@/lib/shell/translate";
import { toneFor } from "@/lib/states";
import { ApprovalForm, DeliverableForm } from "./forms";
import { SponsorAssetForm } from "./sponsor-forms";
import { AreaClosed, RowList, TabEmpty } from "./rows";
import type { TabProps } from "./tab-context";
import { DocumentActions } from "@/components/documents/document-actions";

/**
 * Client, contractor and sponsor tabs (Section 4.4.4): approvals and change orders, the shared
 * schedule and run of show, reports, contractor scope and deliverables, sponsor entitlements,
 * asset approvals, activation schedule and proof of performance. Clients never see internal notes,
 * margins or other parties' rates: the api_external views carry none of them.
 */

export async function ApprovalsTab({ view, t, locale, engagementKey }: TabProps) {
  const approvals = await readView(view.ctx.db, "client_approvals", {
    eq: { engagement_id: view.engagement.id },
    order: ["requested_at", "desc"],
  });
  if (!approvals.ok) return <RegionError />;
  if (approvals.data.length === 0) {
    return (
      <TabEmpty
        icon="Stamp"
        sentence={t("gateway.engagement.approvals.empty")}
        actionLabel={t("gateway.engagement.changeOrdersAction")}
        href={tabHref(engagementKey, "engagement.change-orders")}
      />
    );
  }
  return (
    <RowList
      label={t("nav.gateway.engagementTabs.approvals")}
      items={approvals.data.map((a) => ({
        id: a.id ?? "",
        title: a.message ?? t(enumLabelKey("clientApprovalSubject", a.subject_kind ?? "Record")),
        meta: [
          a.subject_kind ? t(enumLabelKey("clientApprovalSubject", a.subject_kind)) : null,
          a.requested_at
            ? t("gateway.engagement.approvals.requested", {
                date: formatDate(locale, a.requested_at),
              })
            : null,
          a.response,
        ],
        ...(a.decision
          ? {
              tag: {
                label: t(enumLabelKey("approvalDecision", a.decision)),
                tone: toneFor(a.decision),
              },
            }
          : { tag: { label: t("gateway.engagement.approvals.waiting"), tone: "accent" as const } }),
        ...(!a.decision && a.id
          ? { detail: <ApprovalForm requestId={a.id} subject={a.message ?? ""} /> }
          : {}),
      }))}
    />
  );
}

export async function ChangeOrdersTab({ view, t, locale, engagementKey }: TabProps) {
  const [orders, approvals] = await Promise.all([
    readView(view.ctx.db, "change_orders", {
      eq: { project_id: view.engagement.projectId },
      order: ["change_order_key", "desc"],
    }),
    readView(view.ctx.db, "client_approvals", { eq: { engagement_id: view.engagement.id } }),
  ]);
  if (!orders.ok || !approvals.ok) return <RegionError />;
  const ids = orders.data.flatMap((o) => (o.id ? [o.id] : []));
  const lines = await readView(view.ctx.db, "change_order_lines", { in: ["change_order_id", ids] });
  if (!lines.ok) return <RegionError />;
  if (orders.data.length === 0) {
    return (
      <TabEmpty
        icon="FileDiff"
        sentence={t("gateway.engagement.changeOrders.empty")}
        actionLabel={t("gateway.engagement.messagesAction")}
        href={tabHref(engagementKey, "engagement.messages")}
      />
    );
  }
  return (
    <RowList
      label={t("nav.gateway.engagementTabs.changeOrders")}
      items={orders.data.map((o) => {
        const pending = approvals.data.find((a) => a.change_order_id === o.id && !a.decision);
        return {
          id: o.id ?? "",
          title: [o.change_order_key, o.title].filter(Boolean).join(" · "),
          meta: [
            o.change_purpose,
            formatMoney(locale, o.total_minor, o.currency_code) ?? t("gateway.common.unpriced"),
          ],
          ...(o.change_order_state
            ? {
                tag: {
                  label: t(enumLabelKey("changeOrderState", o.change_order_state)),
                  tone: toneFor(o.change_order_state),
                },
              }
            : {}),
          detail: (
            <div className="flex flex-col gap-8">
              <ul className="m-0 flex list-none flex-col gap-2 ps-12 text-text-13 text-text-secondary">
                {lines.data
                  .filter((l) => l.change_order_id === o.id)
                  .map((l) => (
                    <li key={l.id ?? ""}>
                      {[
                        l.description,
                        l.is_no_cost
                          ? t("gateway.engagement.changeOrders.noCost")
                          : (formatMoney(locale, l.amount_minor, o.currency_code) ??
                            t("gateway.common.unpriced")),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </li>
                  ))}
              </ul>
              {pending?.id ? <ApprovalForm requestId={pending.id} subject={o.title ?? ""} /> : null}
              {o.id ? (
                <DocumentActions kind="change-order" id={o.id} engagementKey={engagementKey} />
              ) : null}
            </div>
          ),
        };
      })}
    />
  );
}

/** Shared records of the project as a list or a month calendar (Section 11.15). */
export async function RecordsTab({
  view,
  t,
  locale,
  engagementKey,
  kinds,
  emptyKey,
  icon,
  calendar,
}: TabProps & {
  kinds?: readonly RecordKind[];
  emptyKey: string;
  icon: string;
  calendar?: boolean;
}) {
  if (!hasArea(view, "operational")) {
    return <AreaClosed view={view} t={t} engagementKey={engagementKey} />;
  }
  const records = await listSharedRecords(view.ctx.db, {
    projectIds: [view.engagement.projectId],
    ...(kinds ? { kinds } : {}),
  });
  if (!records.ok) return <RegionError />;
  if (records.data.length === 0) {
    return (
      <TabEmpty
        icon={icon}
        sentence={t(emptyKey)}
        actionLabel={t("gateway.engagement.messagesAction")}
        href={tabHref(engagementKey, "engagement.messages")}
      />
    );
  }
  const first = recordDate(records.data[0] ?? { startsAt: null, dueAt: null, endsAt: null });
  return (
    <div className="flex flex-col gap-16">
      {calendar && first !== "9999-12-31" ? (
        <Calendar
          month={`${first.slice(0, 7)}-01`}
          today={view.today}
          events={records.data.map((r) => ({
            date: recordDate(r).slice(0, 10),
            label: r.title,
            state: "scheduled" as const,
          }))}
        />
      ) : null}
      <RowList
        label={t(emptyKey)}
        items={records.data.map((r) => ({
          id: r.id,
          title: r.title,
          meta: [
            t(enumLabelKey("recordKind", r.kind)),
            r.startsAt && r.startTbc
              ? t("gateway.common.tbc")
              : r.startsAt
              ? formatScheduleTime(
                  locale,
                  r.startsAt,
                  r.timeZone ?? view.engagement.projectTimeZone,
                  view.scheduleView,
                )
              : r.dueAt
                ? t("gateway.engagement.due", {
                    date: formatScheduleTime(
                      locale,
                      r.dueAt,
                      r.timeZone ?? view.engagement.projectTimeZone,
                      view.scheduleView,
                    ),
                  })
                : null,
          ],
          tag: { label: t(enumLabelKey("recordState", r.state)), tone: toneFor(r.state) },
        }))}
      />
    </div>
  );
}

export async function RunOfShowTab({ view, t, locale, engagementKey }: TabProps) {
  if (!hasArea(view, "operational")) {
    return <AreaClosed view={view} t={t} engagementKey={engagementKey} />;
  }
  const shows = await readView(view.ctx.db, "run_of_show", {
    eq: { project_id: view.engagement.projectId },
    order: ["show_date", "asc"],
  });
  if (!shows.ok) return <RegionError />;
  const ids = shows.data.flatMap((s) => (s.id ? [s.id] : []));
  const cues = await readView(view.ctx.db, "cues", {
    in: ["run_of_show_id", ids],
    order: ["position", "asc"],
  });
  if (!cues.ok) return <RegionError />;
  if (shows.data.length === 0) {
    return (
      <TabEmpty
        icon="ListOrdered"
        sentence={t("gateway.engagement.runOfShow.empty")}
        actionLabel={t("gateway.engagement.scheduleAction")}
        href={tabHref(
          engagementKey,
          view.tabs.includes("engagement.schedule") ? "engagement.schedule" : "engagement.overview",
        )}
      />
    );
  }
  return (
    <div className="flex flex-col gap-16">
      {shows.data.map((show) => (
        <Section
          key={show.id ?? ""}
          id={`show-${show.id}`}
          title={[show.name, show.show_date ? formatDate(locale, show.show_date) : null]
            .filter(Boolean)
            .join(" · ")}
        >
          {show.id ? (
            <DocumentActions kind="run-of-show" id={show.id} engagementKey={engagementKey} />
          ) : null}
          <RowList
            label={show.name ?? ""}
            items={cues.data
              .filter((c) => c.run_of_show_id === show.id)
              .map((c) => ({
                id: c.id ?? "",
                title: `${c.position ?? ""}. ${c.label ?? ""}`,
                meta: [
                  c.planned_at && c.start_tbc
                    ? t("gateway.common.tbc")
                    : c.planned_at
                    ? formatScheduleTime(
                        locale,
                        c.planned_at,
                        view.engagement.projectTimeZone,
                        view.scheduleView,
                        "time",
                      )
                    : null,
                  c.duration,
                  c.called_at
                    ? t("gateway.engagement.runOfShow.called", {
                        time: formatDateTime(locale, c.called_at),
                      })
                    : null,
                ],
                ...(c.is_my_set
                  ? {
                      tag: {
                        label: t("gateway.engagement.runOfShow.mySet"),
                        tone: "accent" as const,
                      },
                    }
                  : {}),
              }))}
          />
        </Section>
      ))}
    </div>
  );
}

/** Contractor scope: the statement of work and the milestones shared for the engagement. */
export async function ScopeTab(props: TabProps) {
  const { view, t, locale, engagementKey } = props;
  const docs = await listEngagementDocuments(view.ctx.db, view.engagement.id);
  if (!docs.ok) return <RegionError />;
  const sow = docs.data.filter((d) => d.kind === "Statement of Work" || d.kind === "Agreement");
  return (
    <div className="flex flex-col gap-16">
      <Section title={t("gateway.engagement.scope.statement")}>
        {sow.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("gateway.engagement.scope.noStatement")}
          </p>
        ) : (
          <RowList
            label={t("gateway.engagement.scope.statement")}
            items={sow.map((d) => ({
              id: d.id,
              title: d.title,
              meta: [t(enumLabelKey("engagementDocumentKind", d.kind))],
              tag: {
                label: t(enumLabelKey("engagementDocumentState", d.state)),
                tone: toneFor(d.state),
              },
              href: tabHref(engagementKey, "engagement.documents"),
            }))}
          />
        )}
      </Section>
      <Section title={t("gateway.engagement.scope.milestones")}>
        <RecordsTab
          view={view}
          t={t}
          locale={locale}
          engagementKey={engagementKey}
          kinds={["Milestone", "Deadline", "Task"]}
          emptyKey="gateway.engagement.scope.noMilestones"
          icon="Flag"
        />
      </Section>
    </div>
  );
}

export async function DeliverablesTab({ view, t, locale, engagementKey }: TabProps) {
  const [deliverables, docs] = await Promise.all([
    readView(view.ctx.db, "deliverables", {
      eq: { engagement_id: view.engagement.id },
      order: ["due_at", "asc"],
    }),
    listEngagementDocuments(view.ctx.db, view.engagement.id),
  ]);
  if (!deliverables.ok || !docs.ok) return <RegionError />;
  if (deliverables.data.length === 0) {
    return (
      <TabEmpty
        icon="PackageCheck"
        sentence={t("gateway.engagement.deliverables.empty")}
        actionLabel={t("gateway.engagement.scopeAction")}
        href={tabHref(engagementKey, "engagement.scope")}
      />
    );
  }
  const documents = docs.data.flatMap((d) =>
    d.documentId ? [{ id: d.documentId, title: d.title }] : [],
  );
  return (
    <RowList
      label={t("nav.gateway.engagementTabs.deliverables")}
      items={deliverables.data.map((d) => {
        const open = d.deliverable_state === "Open" || d.deliverable_state === "Returned";
        return {
          id: d.id ?? "",
          title: d.title ?? "",
          meta: [
            d.due_at
              ? t("gateway.engagement.due", { date: formatDateTime(locale, d.due_at) })
              : null,
            d.submitted_at
              ? t("gateway.engagement.deliverables.submitted", {
                  date: formatDate(locale, d.submitted_at),
                })
              : null,
            d.deliverable_state === "Returned" ? d.return_reason : null,
            d.fee_minor !== null && d.fee_minor !== undefined
              ? t("payouts.milestone.fee", {
                  amount: formatMoney(locale, d.fee_minor, d.currency_code) ?? "",
                })
              : null,
          ],
          ...(d.deliverable_state
            ? {
                tag: {
                  label: t(enumLabelKey("deliverableState", d.deliverable_state)),
                  tone: toneFor(d.deliverable_state),
                },
              }
            : {}),
          ...(open && d.id
            ? {
                detail: (
                  <DeliverableForm
                    deliverableId={d.id}
                    title={d.title ?? ""}
                    documents={documents}
                  />
                ),
              }
            : {}),
        };
      })}
    />
  );
}

export async function EntitlementsTab({ view, t, locale, engagementKey }: TabProps) {
  const entitlements = await readView(view.ctx.db, "sponsor_entitlements", {
    eq: { project_id: view.engagement.projectId },
    order: ["due_on", "asc"],
  });
  if (!entitlements.ok) return <RegionError />;
  if (entitlements.data.length === 0) {
    return (
      <TabEmpty
        icon="Gift"
        sentence={t("gateway.engagement.entitlements.empty")}
        actionLabel={t("gateway.engagement.messagesAction")}
        href={tabHref(engagementKey, "engagement.messages")}
      />
    );
  }
  return (
    <RowList
      label={t("nav.gateway.engagementTabs.entitlements")}
      items={entitlements.data.map((e) => ({
        id: e.id ?? "",
        title: e.description ?? "",
        meta: [
          e.quantity ? t("gateway.engagement.entitlements.quantity", { n: e.quantity }) : null,
          e.due_on ? t("gateway.engagement.due", { date: formatDate(locale, e.due_on) }) : null,
          e.fulfilled_at
            ? t("gateway.engagement.entitlements.fulfilled", {
                date: formatDate(locale, e.fulfilled_at),
              })
            : null,
        ],
        tag: e.fulfilled_at
          ? { label: t("gateway.engagement.entitlements.done"), tone: "success" as const }
          : e.is_overdue
            ? { label: t("gateway.engagement.entitlements.overdue"), tone: "danger" as const }
            : { label: t("gateway.engagement.entitlements.open"), tone: "accent" as const },
      }))}
    />
  );
}

/**
 * Sponsor asset approvals (journey 47, migration 1133): the brand assets the org submitted for the
 * sponsor's entitlements on this project, each with its kind, revision and review state. The
 * sponsor approves or returns a submitted asset and resubmits a returned one; approved and
 * canceled ones are final.
 */
export async function AssetApprovalsTab({ view, t, locale, engagementKey }: TabProps) {
  const assets = await readView(view.ctx.db, "sponsor_assets", {
    eq: { project_id: view.engagement.projectId },
    order: ["due_on", "asc"],
  });
  if (!assets.ok) return <RegionError />;
  if (assets.data.length === 0) {
    return (
      <TabEmpty
        icon="Image"
        sentence={t("gateway.engagement.assets.empty")}
        actionLabel={t("gateway.engagement.messagesAction")}
        href={tabHref(engagementKey, "engagement.messages")}
      />
    );
  }
  return (
    <RowList
      label={t("nav.gateway.engagementTabs.assetApprovals")}
      items={assets.data.map((a) => {
        const state = a.asset_state ?? "Submitted";
        return {
          id: a.id ?? "",
          title: a.title ?? "",
          meta: [
            a.asset_kind ? t(enumLabelKey("sponsorAssetKind", a.asset_kind)) : null,
            a.entitlement_description,
            a.due_on
              ? t("gateway.engagement.assets.due", { date: formatDate(locale, a.due_on) })
              : null,
            a.revision ? t("gateway.engagement.assets.revision", { n: a.revision }) : null,
            a.usage_note,
          ],
          tag: {
            label: a.awaiting_sponsor
              ? t("gateway.engagement.assets.awaiting")
              : t(enumLabelKey("reviewState", state)),
            tone: a.awaiting_sponsor ? ("accent" as const) : toneFor(state),
          },
          ...((state === "Submitted" || state === "Returned") && a.id
            ? {
                detail: <SponsorAssetForm assetId={a.id} title={a.title ?? ""} state={state} />,
              }
            : {}),
        };
      })}
    />
  );
}
