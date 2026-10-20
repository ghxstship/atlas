import { getSwap, listSwaps, SWAP_STATES, type ShiftSwap } from "@xos/data/crew";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import { acceptSwapAction, cancelSwapAction, decideSwapAction } from "@/app/[org]/crew/actions";
import { resolveSettings } from "@xos/data/settings";
import { ConfirmButton } from "@/components/crew/forms-confirm-button";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { CrewRecord } from "@/components/crew/record";
import { FilterSelect } from "@/components/crew/views-filter-select";
import { PeekBoard } from "@/components/crew/views-peek-board";
import { PeekTable } from "@/components/crew/views-peek-table";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { flatParams, getCrewContext, getRoleTitles, withParams } from "@/lib/crew/context";
import { stateIcon } from "@/lib/crew/states";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Crew > Swaps (Section 4.5.5): shift swap requests in list, table and board views. A supervisor who
 * is neither party approves or rejects (invariant 18); the requester withdraws. Swaps are asked for
 * from the shift itself, so the page's action leads to Shifts.
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/crew/swaps">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "crew.swaps";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  const roles = await getRoleTitles(crew.ctx);
  const stateFilter = SWAP_STATES.find((s) => s === search["state"]);
  const result = await listSwaps(db, {
    orgId: crew.orgId,
    ...(stateFilter ? { states: [stateFilter] } : {}),
  });
  if (!result.ok) throw new Error(`Cannot list swaps: ${result.error.kind}`);
  const swaps = result.data;
  const name = (n: string | null) => n ?? t("crew.common.unnamed");
  const shiftWhen = (s: ShiftSwap) =>
    s.shiftStartsAt
      ? format.dateTime(new Date(s.shiftStartsAt), { dateStyle: "medium", timeStyle: "short" })
      : "";
  const title = (s: ShiftSwap) =>
    t("crew.swapsPage.title", { from: name(s.requestedBy.name), to: name(s.proposed.name) });
  const peekHref = (id: string) => withParams(base, search, { peek: id, full: null });

  let peek = null;
  if (search["peek"]) {
    const detail = await getSwap(db, search["peek"]);
    if (detail.ok) {
      const s = detail.data;
      const party =
        s.requestedBy.membershipId === crew.membershipId ||
        s.proposed.membershipId === crew.membershipId;
      const hidden = { org: crew.slug, id: s.id };
      // scheduling.swap_requires_approval (1322): off lets the person offered the shift accept it.
      const scheduling = await resolveSettings(db, { orgId: crew.orgId, projectId: s.projectId });
      const needsApproval =
        !scheduling.ok || scheduling.data.get("scheduling.swap_requires_approval")?.value !== false;
      const record = (
        <CrewRecord
          crew={crew}
          mode={search["full"] === "1" ? "full" : "peek"}
          subject={{ table: "app.shift_swaps", id: s.id }}
          kindLabel={t("crew.kinds.swap")}
          recordKey={s.projectKey}
          title={title(s)}
          state={stateIcon("swap", s.state)}
          stateLabel={t(`crew.states.swap.${s.state}`)}
          stateName={(v) => t(`crew.states.swap.${v}`)}
          history={s.transitions}
          backHref={withParams(base, search, { peek: null, full: null })}
          actions={
            s.state === "Proposed" ? (
              <>
                {crew.can("crew.swap.approve") && !party ? (
                  <>
                    <ConfirmButton
                      label={t("crew.swapsPage.approve")}
                      title={t("crew.swapsPage.approveTitle")}
                      defaultReason={t("crew.swapsPage.approveReason")}
                      action={decideSwapAction}
                      hidden={{ ...hidden, decision: "Approved" }}
                      variant="primary"
                    />
                    <ConfirmButton
                      label={t("crew.swapsPage.reject")}
                      title={t("crew.swapsPage.rejectTitle")}
                      defaultReason={t("crew.swapsPage.rejectReason")}
                      action={decideSwapAction}
                      hidden={{ ...hidden, decision: "Rejected" }}
                    />
                  </>
                ) : null}
                {!needsApproval && s.proposed.membershipId === crew.membershipId ? (
                  <ConfirmButton
                    label={t("crew.swapsPage.accept")}
                    title={t("crew.swapsPage.acceptTitle")}
                    defaultReason={t("crew.swapsPage.acceptReason")}
                    action={acceptSwapAction}
                    hidden={hidden}
                    variant="primary"
                  />
                ) : null}
                {s.requestedBy.membershipId === crew.membershipId ? (
                  <ConfirmButton
                    label={t("crew.swapsPage.withdraw")}
                    title={t("crew.swapsPage.withdrawTitle")}
                    defaultReason={t("crew.swapsPage.withdrawReason")}
                    action={cancelSwapAction}
                    hidden={hidden}
                    variant="ghost"
                  />
                ) : null}
              </>
            ) : null
          }
          properties={[
            { label: t("crew.fields.project"), value: s.projectKey },
            { label: t("crew.swapsPage.requestedBy"), value: name(s.requestedBy.name) },
            { label: t("crew.swaps.proposed"), value: name(s.proposed.name) },
            {
              label: t("crew.fields.role"),
              value: s.roleCode
                ? (roles.get(s.roleCode)?.title ?? s.roleCode)
                : t("crew.common.noRole"),
            },
            { label: t("crew.fields.when"), value: shiftWhen(s) },
            {
              label: t("crew.kinds.shift"),
              value: (
                <Link
                  href={`/${crew.slug}/crew/shifts?peek=${s.shiftId}` as Route}
                  className="text-accent-text underline"
                >
                  {t("crew.swapsPage.openShift")}
                </Link>
              ),
            },
          ]}
        />
      );
      if (search["full"] === "1") return record;
      peek = record;
    } else if (detail.error.kind !== "not-found") {
      throw new Error(`Cannot read swap: ${detail.error.kind}`);
    }
  }

  let body;
  if (swaps.length === 0) {
    body = (
      <EmptyStateLink
        icon="ArrowLeftRight"
        sentence={stateFilter ? t("crew.swapsPage.emptyFiltered") : t("crew.swapsPage.empty")}
        actionLabel={stateFilter ? t("crew.common.clearFilter") : t("crew.swapsPage.viewShifts")}
        href={stateFilter ? withParams(base, search, { state: null }) : `/${crew.slug}/crew/shifts`}
      />
    );
  } else if (view === "board") {
    body = (
      <PeekBoard
        columns={SWAP_STATES.map((st) => ({
          state: stateIcon("swap", st),
          label: t(`crew.states.swap.${st}`),
          cards: swaps
            .filter((s) => s.state === st)
            .map((s) => ({
              key: s.id,
              title: title(s),
              meta: `${s.projectKey} · ${shiftWhen(s)}`,
            })),
        }))}
      />
    );
  } else if (view === "table") {
    body = (
      <PeekTable
        caption={t("crew.swapsPage.caption")}
        columns={[
          { key: "project", label: t("crew.fields.project"), type: "code" },
          { key: "from", label: t("crew.swapsPage.requestedBy") },
          { key: "to", label: t("crew.swaps.proposed") },
          { key: "when", label: t("crew.fields.when") },
          { key: "state", label: t("crew.fields.state"), type: "state" },
        ]}
        rows={swaps.map((s) => ({
          id: s.id,
          project: s.projectKey,
          from: name(s.requestedBy.name),
          to: name(s.proposed.name),
          when: shiftWhen(s),
          state: { state: stateIcon("swap", s.state), label: t(`crew.states.swap.${s.state}`) },
        }))}
      />
    );
  } else {
    body = (
      <ul
        aria-label={t("crew.swapsPage.caption")}
        className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
      >
        {swaps.map((s) => (
          <li key={s.id}>
            <Link
              href={peekHref(s.id) as Route}
              className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <span className="flex flex-col">
                <span className="text-text-13 font-medium">{title(s)}</span>
                <span className="text-text-12 text-text-secondary">
                  {t("crew.common.pair", { a: s.projectKey, b: shiftWhen(s) })}
                </span>
              </span>
              <span className="text-text-12 text-text-secondary">
                {t(`crew.states.swap.${s.state}`)}
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
      count={swaps.length}
      view={view}
      actions={
        <ButtonLink href={`/${crew.slug}/crew/shifts`} size="sm">
          {t("crew.swapsPage.viewShifts")}
        </ButtonLink>
      }
      filters={
        <FilterSelect
          name="state"
          label={t("crew.fields.state")}
          value={stateFilter ?? ""}
          options={[
            { value: "", label: t("crew.common.allStates") },
            ...SWAP_STATES.map((v) => ({ value: v, label: t(`crew.states.swap.${v}`) })),
          ]}
        />
      }
      peek={peek}
    >
      {body}
    </CrewFrame>
  );
}
