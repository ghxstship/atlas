import {
  ALLOCATION_DISPLAY_STATUSES,
  ALLOCATION_KINDS,
  allowanceFor,
  listAllocationAllowances,
  listAllocationHolders,
  listAllocations,
  listReservationConflicts,
  radioHandout,
  type Allocation,
  type AllocationAllowance,
  type AllocationHolder,
} from "@xos/data/allocations";
import Link from "next/link";
import type { Route } from "next";
import dynamic from "next/dynamic";
import { notFound } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { LiveRefresh } from "@/components/live/live-refresh";
import { collectionPeek } from "@/components/shell/collection-peek";
import {
  ALLOCATION_RECORD_STATE,
  allocationActions,
  allocationBulkConfig,
  allocationMatrix,
  copyKey,
  groupByStatus,
  holderOf,
  partyOf,
  visibleAllocations,
} from "@/lib/advancing/allocations";
import { getTranslate } from "@/lib/shell/translate";
import type { AdvancingContext } from "./context";
import { isRowId, pickView, withQuery, type Search } from "./shared";
import { InlineAlert, PageHeader, StateChip } from "./ui";
import { PeekPanel, PeekTable, SelectFilter, ViewSwitcher } from "./views";

// The dialogs load with their first open, so the page carries none of their code (bundle budget).
const AllocationAssignDialog = dynamic(() =>
  import("./allocation-dialogs").then((m) => m.AllocationAssignDialog),
);
const AllocationRowActions = dynamic(() =>
  import("./allocation-dialogs").then((m) => m.AllocationRowActions),
);

const VIEWS = ["list", "table", "matrix"] as const;

/** An instant as a datetime-local value in a zone. */
function localIn(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(iso))
    .replace(" ", "T");
}

/**
 * Advancing > Allocations (R7, ADR 0103 and 0104): what each party and person is given, from
 * app.advance_allocation_status, as a list grouped by computed status, a table with bulk approve and decline, and a
 * people by kind matrix. Filters by kind, status, party and holds in conflict (app.asset_reservation_conflicts, with
 * a banner counting them). The Allowance column reads app.allocation_allowances once per engagement shown. A radio
 * allocation shows its channels and, when radios are allocated, the page links the radio hand-out. Every write is a
 * dialog loaded on demand; the database decides it.
 */
export async function AllocationsCollection({
  actx,
  path,
  search,
  title,
}: {
  actx: AdvancingContext;
  path: string;
  search: Search;
  title: string;
}) {
  const { ctx, can, project } = actx;
  const t = await getTranslate();
  const format = await getFormatter();
  const db = ctx.viewer.db;
  const view = pickView(search, VIEWS, "list");
  const kind = ALLOCATION_KINDS.find((k) => k === search["kind"]);
  const status = ALLOCATION_DISPLAY_STATUSES.find((s) => s === search["filter"]);
  const party = search["party"] || undefined;
  const onlyConflicts = search["conflicts"] === "1";

  const [rows, conflicts, projectRow] = await Promise.all([
    listAllocations(db, { orgId: ctx.org.id, ...(project ? { projectId: project.id } : {}) }),
    listReservationConflicts(db, {
      orgId: ctx.org.id,
      ...(project ? { projectId: project.id } : {}),
    }),
    project
      ? db.from("projects").select("time_zone").eq("id", project.id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (!rows.ok) throw new Error(`Cannot list allocations: ${JSON.stringify(rows.error)}`);
  const conflictRows = conflicts.ok ? conflicts.data : [];
  const timeZone = (projectRow.data as { time_zone?: string | null } | null)?.time_zone ?? "UTC";

  const projectIds = [...new Set(rows.data.map((a) => a.projectId))];
  const holderLists = await Promise.all(projectIds.map((id) => listAllocationHolders(db, id)));
  const holders: AllocationHolder[] = holderLists.flatMap((r) => (r.ok ? r.data : []));

  const shown = visibleAllocations(rows.data, holders, {
    kind,
    status,
    party,
    conflicts: onlyConflicts ? new Set(conflictRows.map((c) => c.allocationId)) : undefined,
  });
  const engagementOf = (a: Allocation) =>
    a.holderEngagementId ??
    holders.find((h) => h.rosterEntryId === a.rosterEntryId)?.engagementId ??
    null;

  // The Allowance column: one read per engagement shown, only in the table where it shows.
  const allowanceByEngagement = new Map<string, readonly AllocationAllowance[]>();
  if (view === "table") {
    const engagements = [
      ...new Set(shown.flatMap((a) => (engagementOf(a) ? [engagementOf(a) as string] : []))),
    ];
    const reads = await Promise.all(engagements.map((id) => listAllocationAllowances(db, id)));
    engagements.forEach((id, i) => {
      const r = reads[i];
      if (r?.ok) allowanceByEngagement.set(id, r.data);
    });
  }

  // Classes of asset allocations, for availability in Review; channels of radio allocations, from the hand-out read.
  const assetIds = shown.filter((a) => a.kind === "Asset").map((a) => a.id);
  const classes =
    assetIds.length > 0
      ? await db.from("advance_allocations").select("id, asset_class_id").in("id", assetIds)
      : { data: [] as { id: string; asset_class_id: string | null }[] };
  const classOf = new Map((classes.data ?? []).map((c) => [c.id, c.asset_class_id]));
  const radioProjects = [
    ...new Set(shown.filter((a) => a.offering === "Radios").map((a) => a.projectId)),
  ];
  const handouts = await Promise.all(radioProjects.map((id) => radioHandout(db, id)));
  const channelsOf = new Map<string, readonly number[]>();
  for (const h of handouts)
    if (h.ok) for (const line of h.data) channelsOf.set(line.allocationId, line.channelNumbers);

  const kindLabel = (k: string) => t(`advancing.allocations.kinds.${copyKey(k)}`);
  const statusLabel = (s: string) => t(`advancing.allocations.statuses.${copyKey(s)}`);
  const windowLabel = (a: Allocation) =>
    a.neededFrom && a.neededTo
      ? format.dateTimeRange(new Date(a.neededFrom), new Date(a.neededTo), {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: a.timeZone,
        })
      : t("advancing.allocations.noWindow");
  const itemLabel = (a: Allocation) => a.itemName ?? kindLabel(a.kind);
  const holderLabel = (a: Allocation) =>
    a.rosterEntryId
      ? holderOf(a, holders)
      : t("advancing.allocations.pool", { party: partyOf(a, holders) });
  const channelsLabel = (a: Allocation) => {
    const numbers = channelsOf.get(a.id);
    return numbers && numbers.length > 0
      ? t("advancing.allocations.channels.row", { numbers: numbers.join(", ") })
      : "";
  };
  const allowanceLabel = (a: Allocation) => {
    const e = engagementOf(a);
    const row = e
      ? allowanceFor(allowanceByEngagement.get(e) ?? [], a.offering, a.rosterEntryId)
      : null;
    return row && row.cap !== null && row.remaining !== null
      ? t("advancing.allocations.allowance.column", { remaining: row.remaining, cap: row.cap })
      : t("advancing.allocations.allowance.none");
  };
  const rowProps = (a: Allocation) => ({
    id: a.id,
    kind: a.kind,
    quantity: a.quantity,
    issued: a.issuedQuantity,
    item: itemLabel(a),
    holder: holderLabel(a),
    window: windowLabel(a),
    offering: a.offering,
    rosterEntryId: a.rosterEntryId,
    engagementId: engagementOf(a),
    projectId: a.projectId,
    assetClassId: classOf.get(a.id) ?? null,
    fromLocal: localIn(a.neededFrom, a.timeZone),
    toLocal: localIn(a.neededTo, a.timeZone),
    timeZone: a.timeZone,
  });
  const parties = [...new Set(rows.data.map((a) => partyOf(a, holders)).filter(Boolean))].sort();
  const peekId = search["peek"];
  const peek = peekId ? rows.data.find((a) => a.id === peekId) : undefined;
  if (peekId && isRowId(peekId) && !peek) notFound();
  const projectConflicts = conflictRows.length;
  const hasRadios =
    project !== null && shown.some((a) => a.offering === "Radios" && a.state === "Approved");
  const matrix = view === "matrix" ? allocationMatrix(shown, holders) : null;

  const actionsFor = (a: Allocation) => {
    const list = allocationActions(a, can);
    return list.length > 0 ? (
      <AllocationRowActions org={ctx.org.slug} row={rowProps(a)} actions={list} />
    ) : null;
  };

  return (
    <div className="flex flex-col gap-12 min-w-0">
      <PageHeader
        title={title}
        count={shown.length}
        views={<ViewSwitcher views={VIEWS} current={view} />}
        {...(project && (can.write || can.review)
          ? {
              actions: (
                <AllocationAssignDialog
                  org={ctx.org.slug}
                  projectId={project.id}
                  timeZone={timeZone}
                  canAssign={can.review}
                  canRequest={can.write}
                />
              ),
            }
          : {})}
      />
      <p className="m-0 text-text-13 text-text-secondary">
        {can.write || can.review
          ? t("advancing.allocations.sentence")
          : t("advancing.allocations.readOnly")}
      </p>
      {projectConflicts > 0 ? (
        <InlineAlert
          tone="warning"
          title={t("advancing.allocations.conflicts.banner", { n: projectConflicts })}
        >
          <Link
            href={withQuery(path, search, { conflicts: "1" }) as Route}
            className="hover:underline"
          >
            {t("advancing.allocations.conflicts.show")}
          </Link>
        </InlineAlert>
      ) : null}
      <div className="flex flex-wrap items-end gap-8">
        <SelectFilter
          id="allocation-kind"
          label={t("advancing.allocations.filters.kind")}
          param="kind"
          value={kind ?? ""}
          options={[
            { value: "", label: t("advancing.allocations.filters.allKinds") },
            ...ALLOCATION_KINDS.map((k) => ({ value: k, label: kindLabel(k) })),
          ]}
        />
        <SelectFilter
          id="allocation-status"
          label={t("advancing.allocations.filters.status")}
          param="filter"
          value={status ?? ""}
          options={[
            { value: "", label: t("advancing.allocations.filters.allStatuses") },
            ...ALLOCATION_DISPLAY_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })),
          ]}
        />
        <SelectFilter
          id="allocation-party"
          label={t("advancing.allocations.filters.party")}
          param="party"
          value={party ?? ""}
          options={[
            { value: "", label: t("advancing.allocations.filters.allParties") },
            ...parties.map((p) => ({ value: p, label: p })),
          ]}
        />
        <SelectFilter
          id="allocation-conflicts"
          label={t("advancing.allocations.filters.conflicts")}
          param="conflicts"
          value={onlyConflicts ? "1" : ""}
          options={[
            { value: "", label: t("advancing.allocations.filters.allStatuses") },
            { value: "1", label: t("advancing.allocations.filters.conflicts") },
          ]}
        />
        {hasRadios && project ? (
          <Link
            href={`/${ctx.org.slug}/documents/radio-handout/${project.id}` as Route}
            className="inline-flex min-h-target-coarse items-center text-text-13 text-text-link hover:underline"
          >
            {t("advancing.allocations.handout")}
          </Link>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <p className="m-0 rounded-card border border-border-subtle p-16 text-text-13 text-text-secondary">
          {rows.data.length === 0
            ? t("advancing.allocations.empty")
            : t("advancing.allocations.emptyFiltered")}
        </p>
      ) : view === "table" ? (
        <PeekTable
          caption={title}
          full={false}
          columns={[
            { key: "item", label: t("advancing.allocations.columns.item") },
            { key: "holder", label: t("advancing.allocations.columns.holder") },
            { key: "party", label: t("advancing.allocations.columns.party") },
            { key: "kind", label: t("advancing.allocations.columns.kind") },
            { key: "quantity", label: t("advancing.allocations.columns.quantity"), type: "number" },
            { key: "window", label: t("advancing.allocations.columns.window") },
            { key: "status", label: t("advancing.allocations.columns.status") },
            { key: "allowance", label: t("advancing.allocations.columns.allowance") },
            { key: "channels", label: t("advancing.allocations.columns.channels") },
          ]}
          bulk={allocationBulkConfig(ctx.org.slug, can.review, {
            state: t("advancing.allocations.bulk.state"),
            approve: t("advancing.allocations.bulk.approve"),
            decline: t("advancing.allocations.bulk.decline"),
          })}
          rows={shown.map((a) => ({
            id: a.id,
            label: `${itemLabel(a)} · ${holderLabel(a)}`,
            item: itemLabel(a),
            holder: holderLabel(a),
            party: partyOf(a, holders),
            kind: kindLabel(a.kind),
            quantity: a.quantity,
            window: windowLabel(a),
            status: statusLabel(a.status),
            allowance: allowanceLabel(a),
            channels: channelsLabel(a),
          }))}
        />
      ) : view === "matrix" && matrix ? (
        matrix.people.length === 0 ? (
          <p className="m-0 rounded-card border border-border-subtle p-16 text-text-13 text-text-secondary">
            {t("advancing.allocations.matrix.empty")}
          </p>
        ) : (
          <div role="region" aria-label={title} tabIndex={0} className="overflow-x-auto">
            <table className="w-full border-collapse text-text-13">
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr className="border-b border-border-subtle">
                  <th scope="col" className="px-8 py-6 text-start font-medium">
                    {t("advancing.allocations.matrix.person")}
                  </th>
                  {matrix.kinds.map((k) => (
                    <th key={k} scope="col" className="px-8 py-6 text-start font-medium">
                      {kindLabel(k)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.people.map((p) => (
                  <tr key={p.rosterEntryId} className="border-b border-border-subtle">
                    <th scope="row" className="px-8 py-6 text-start font-normal">
                      <span className="block">{p.name}</span>
                      <span className="block text-text-12 text-text-secondary">{p.party}</span>
                    </th>
                    {matrix.kinds.map((k) => {
                      const cell = p.cells[k];
                      return (
                        <td key={k} className="px-8 py-6">
                          {cell ? (
                            <StateChip
                              compact
                              state={ALLOCATION_RECORD_STATE[cell.status]}
                              label={`${cell.quantity} · ${statusLabel(cell.status)}`}
                            />
                          ) : (
                            <span className="text-text-tertiary">
                              {t("advancing.allocations.matrix.none")}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        groupByStatus(shown).map(({ status: s, rows: group }) => (
          <section key={s} aria-label={statusLabel(s)} className="flex flex-col gap-4">
            <h2 className="m-0 text-label-14 font-semibold">
              {statusLabel(s)} <span className="text-text-secondary">{group.length}</span>
            </h2>
            <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
              {group.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center justify-between gap-8 px-16 py-8"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-8">
                    <StateChip
                      state={ALLOCATION_RECORD_STATE[a.status]}
                      label={statusLabel(a.status)}
                      compact
                    />
                    <Link
                      href={withQuery(path, search, { peek: a.id }) as Route}
                      className="text-text-14 text-text-primary hover:underline"
                    >
                      {itemLabel(a)}
                    </Link>
                    <span className="text-text-12 text-text-secondary">
                      {[
                        holderLabel(a),
                        `${a.quantity}`,
                        windowLabel(a),
                        a.issuedQuantity > 0
                          ? t("advancing.allocations.issuedOf", {
                              issued: a.issuedQuantity,
                              quantity: a.quantity,
                            })
                          : "",
                        channelsLabel(a),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                  {actionsFor(a)}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {collectionPeek(
        peekId,
        peek ? (
          <PeekPanel
            full={false}
            title={itemLabel(peek)}
            state={ALLOCATION_RECORD_STATE[peek.status]}
            stateLabel={statusLabel(peek.status)}
            properties={[
              { label: t("advancing.allocations.columns.holder"), value: holderLabel(peek) },
              { label: t("advancing.allocations.columns.party"), value: partyOf(peek, holders) },
              { label: t("advancing.allocations.columns.kind"), value: kindLabel(peek.kind) },
              { label: t("advancing.allocations.columns.quantity"), value: String(peek.quantity) },
              { label: t("advancing.allocations.columns.window"), value: windowLabel(peek) },
              {
                label: t("advancing.allocations.columns.issued"),
                value: t("advancing.allocations.issuedOf", {
                  issued: peek.issuedQuantity,
                  quantity: peek.quantity,
                }),
              },
              ...(channelsLabel(peek)
                ? [
                    {
                      label: t("advancing.allocations.columns.channels"),
                      value: channelsLabel(peek),
                    },
                  ]
                : []),
            ]}
          >
            {actionsFor(peek)}
          </PeekPanel>
        ) : null,
      )}
      <LiveRefresh topics={[{ table: "advance_allocations", filter: `org_id=eq.${ctx.org.id}` }]} />
    </div>
  );
}
