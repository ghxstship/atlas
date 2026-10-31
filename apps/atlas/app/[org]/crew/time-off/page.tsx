import {
  getTimeOffRequest,
  listTimeOffPolicies,
  listTimeOffRequests,
  TIME_OFF_STATES,
  type TimeOffRequest,
} from "@xos/data/crew";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import {
  cancelTimeOffAction,
  decideTimeOffAction,
  requestTimeOffAction,
} from "@/app/[org]/crew/actions";
import { ConfirmButton } from "@/components/crew/forms-confirm-button";
import { DrawerForm } from "@/components/crew/forms-drawer-form";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { CrewRecord } from "@/components/crew/record";
import { FilterSelect } from "@/components/crew/views-filter-select";
import { PeekCalendar } from "@/components/crew/views-peek-calendar";
import { PeekTable } from "@/components/crew/views-peek-table";
import { collectionPeek } from "@/components/shell/collection-peek";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { flatParams, getCrewContext, getMembers, withParams } from "@/lib/crew/context";
import { stateIcon } from "@/lib/crew/states";
import { addDays, isIsoDate } from "@/lib/crew/time";
import { peekRowMissing } from "@/lib/shell/peek-handoff";
import { nodeHref } from "@/lib/shell/sitemap";
import { orgToday } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Crew > Time Off (Section 4.5.5): requests under the org's time off policies in list, table and
 * calendar views. An approver other than the requester decides (invariant 18); the requester or an
 * approver cancels. Policies and the holiday calendar are set in Payroll and Time Off settings; a
 * request's days off skip the org calendar's holidays (2270).
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/crew/time-off">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "crew.time-off";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  const stateFilter = TIME_OFF_STATES.find((s) => s === search["state"]);
  const [policiesResult, requestsResult] = await Promise.all([
    listTimeOffPolicies(db, crew.orgId),
    listTimeOffRequests(db, {
      orgId: crew.orgId,
      ...(stateFilter ? { states: [stateFilter] } : {}),
    }),
  ]);
  if (!policiesResult.ok)
    throw new Error(`Cannot list time off policies: ${policiesResult.error.kind}`);
  if (!requestsResult.ok) throw new Error(`Cannot list time off: ${requestsResult.error.kind}`);
  const policies = policiesResult.data;
  const requests = requestsResult.data;
  const canApprove = crew.can("crew.time_off.approve");
  const canRequest = crew.can("crew.time_off.request") || canApprove;
  const name = (r: TimeOffRequest) => r.member.name ?? t("crew.common.unnamed");
  const days = (r: TimeOffRequest) =>
    format.dateTimeRange(new Date(`${r.startsOn}T12:00:00Z`), new Date(`${r.endsOn}T12:00:00Z`), {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    });
  const dayCount = (r: TimeOffRequest) => t("crew.timeOff.dayCount", { count: r.dayCount });
  const title = (r: TimeOffRequest) =>
    t("crew.timeOff.title", { name: name(r), policy: r.policyName });

  let peek = null;
  if (search["peek"]) {
    const detail = await getTimeOffRequest(db, search["peek"]);
    if (detail.ok) {
      const r = detail.data;
      const mine = r.member.membershipId === crew.membershipId;
      const hidden = { org: crew.slug, id: r.id };
      const record = (
        <CrewRecord
          crew={crew}
          mode={search["full"] === "1" ? "full" : "peek"}
          subject={{ table: "app.time_off_requests", id: r.id }}
          kindLabel={t("crew.kinds.timeOff")}
          recordKey={r.startsOn}
          title={title(r)}
          state={stateIcon("timeOff", r.state)}
          stateLabel={t(`crew.states.timeOff.${r.state}`)}
          stateName={(v) => t(`crew.states.timeOff.${v}`)}
          history={r.transitions}
          backHref={withParams(base, search, { peek: null, full: null })}
          actions={
            <>
              {r.state === "Proposed" && canApprove && !mine ? (
                <>
                  <ConfirmButton
                    label={t("crew.swapsPage.approve")}
                    title={t("crew.timeOff.approveTitle")}
                    defaultReason={t("crew.timeOff.approveReason")}
                    action={decideTimeOffAction}
                    hidden={{ ...hidden, decision: "Approved" }}
                    variant="primary"
                  />
                  <ConfirmButton
                    label={t("crew.swapsPage.reject")}
                    title={t("crew.timeOff.rejectTitle")}
                    defaultReason={t("crew.timeOff.rejectReason")}
                    action={decideTimeOffAction}
                    hidden={{ ...hidden, decision: "Rejected" }}
                  />
                </>
              ) : null}
              {(r.state === "Proposed" || r.state === "Approved") && (mine || canApprove) ? (
                <ConfirmButton
                  label={t("crew.timeOff.cancel")}
                  title={t("crew.timeOff.cancelTitle")}
                  defaultReason={t("crew.timeOff.cancelReason")}
                  action={cancelTimeOffAction}
                  hidden={{ ...hidden, expected: r.state }}
                  variant="ghost"
                />
              ) : null}
            </>
          }
          properties={[
            { label: t("crew.fields.person"), value: name(r) },
            { label: t("crew.timeOff.policy"), value: r.policyName },
            { label: t("crew.timeOff.days"), value: days(r) },
            { label: t("crew.timeOff.dayCountLabel"), value: dayCount(r) },
            { label: t("crew.fields.hours"), value: format.number(r.hours) },
          ]}
        />
      );
      if (search["full"] === "1") return record;
      peek = record;
    } else if (!peekRowMissing(detail.error)) {
      throw new Error(`Cannot read time off: ${detail.error.kind}`);
    }
  }

  const members = search["create"] === "1" && canApprove ? await getMembers(crew.ctx) : [];
  // A new request starts today on the org's calendar, never UTC's (a day ahead in the evening).
  const today = await orgToday(crew.ctx);
  const drawer =
    search["create"] === "1" && canRequest && policies.length > 0 ? (
      <DrawerForm
        title={t("crew.timeOff.createTitle")}
        submitLabel={t("crew.timeOff.create")}
        action={requestTimeOffAction}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          canApprove
            ? {
                kind: "select",
                name: "membershipId",
                label: t("crew.fields.person"),
                value: crew.membershipId,
                options: members.map((m) => ({
                  value: m.membershipId,
                  label: m.name ?? t("crew.common.unnamed"),
                })),
              }
            : { kind: "hidden", name: "membershipId", value: crew.membershipId },
          {
            kind: "select",
            name: "policyId",
            label: t("crew.timeOff.policy"),
            options: policies.map((p) => ({ value: p.id, label: p.name })),
          },
          {
            kind: "date",
            name: "startsOn",
            label: t("crew.timeOff.firstDay"),
            value: today,
            required: true,
          },
          {
            kind: "date",
            name: "endsOn",
            label: t("crew.timeOff.lastDay"),
            value: today,
            required: true,
          },
          {
            kind: "number",
            name: "hours",
            label: t("crew.timeOff.hours"),
            value: "8",
            min: "0.5",
            step: "0.5",
            required: true,
          },
        ]}
      />
    ) : null;

  let body;
  if (policies.length === 0) {
    body = (
      <EmptyStateLink
        icon="Palmtree"
        sentence={t("crew.timeOff.noPolicies")}
        actionLabel={t("crew.timeOff.goSettings")}
        href={`/${crew.slug}/settings/payroll-and-time-off`}
      />
    );
  } else if (requests.length === 0) {
    body = (
      <EmptyStateLink
        icon="Palmtree"
        sentence={stateFilter ? t("crew.swapsPage.emptyFiltered") : t("crew.timeOff.empty")}
        actionLabel={stateFilter ? t("crew.common.clearFilter") : t("crew.timeOff.create")}
        href={
          stateFilter
            ? withParams(base, search, { state: null })
            : withParams(base, search, { create: "1" })
        }
      />
    );
  } else if (view === "calendar") {
    const month = isIsoDate(search["month"])
      ? `${search["month"].slice(0, 7)}-01`
      : `${today.slice(0, 7)}-01`;
    body = (
      <PeekCalendar
        month={month}
        today={today}
        events={requests.flatMap((r) => {
          const out: Array<{
            id: string;
            date: string;
            label: string;
            state: ReturnType<typeof stateIcon>;
          }> = [];
          for (let d = r.startsOn; d <= r.endsOn && out.length < 31; d = addDays(d, 1)) {
            out.push({ id: r.id, date: d, label: name(r), state: stateIcon("timeOff", r.state) });
          }
          return out;
        })}
      />
    );
  } else if (view === "table") {
    body = (
      <PeekTable
        caption={t("crew.timeOff.caption")}
        columns={[
          { key: "person", label: t("crew.fields.person") },
          { key: "policy", label: t("crew.timeOff.policy") },
          { key: "days", label: t("crew.timeOff.days") },
          { key: "dayCount", label: t("crew.timeOff.dayCountLabel"), type: "number" },
          { key: "hours", label: t("crew.fields.hours"), type: "number" },
          { key: "state", label: t("crew.fields.state"), type: "state" },
        ]}
        rows={requests.map((r) => ({
          id: r.id,
          person: name(r),
          policy: r.policyName,
          days: days(r),
          dayCount: r.dayCount,
          hours: r.hours,
          state: {
            state: stateIcon("timeOff", r.state),
            label: t(`crew.states.timeOff.${r.state}`),
          },
        }))}
      />
    );
  } else {
    body = (
      <ul
        aria-label={t("crew.timeOff.caption")}
        className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
      >
        {requests.map((r) => (
          <li key={r.id}>
            <Link
              href={withParams(base, search, { peek: r.id }) as Route}
              className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <span className="flex flex-col">
                <span className="text-text-13 font-medium">{title(r)}</span>
                <span className="text-text-12 text-text-secondary">
                  {t("crew.timeOff.meta", {
                    days: days(r),
                    dayCount: dayCount(r),
                    hours: format.number(r.hours),
                  })}
                </span>
              </span>
              <span className="text-text-12 text-text-secondary">
                {t(`crew.states.timeOff.${r.state}`)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <CrewFrame
      crew={crew}
      node={node}
      module="crew"
      params={routeParams}
      search={search}
      count={requests.length}
      view={view}
      {...(canRequest && policies.length > 0
        ? {
            actions: (
              <ButtonLink
                href={withParams(base, search, { create: "1" })}
                variant="primary"
                size="sm"
              >
                {t("crew.timeOff.create")}
              </ButtonLink>
            ),
          }
        : {})}
      filters={
        <FilterSelect
          name="state"
          label={t("crew.fields.state")}
          value={stateFilter ?? ""}
          options={[
            { value: "", label: t("crew.common.allStates") },
            ...TIME_OFF_STATES.map((v) => ({ value: v, label: t(`crew.states.timeOff.${v}`) })),
          ]}
        />
      }
      peek={
        <>
          {collectionPeek(search["peek"], peek)}
          {drawer}
        </>
      }
    >
      {body}
    </CrewFrame>
  );
}
