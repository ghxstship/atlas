import { listRequisitions, type Requisition } from "@xos/data/opportunities";
import { Muted, RowLink, Table, ViewSwitch } from "@/components/opportunities/parts";
import { PageHeader, StateChip, TemplateCollection } from "@/components/opportunities/ui";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { enumKey, formatMoney } from "@/lib/opportunities/format";
import { must, setupPage, type PageSetup, type SearchParams } from "@/lib/opportunities/page";
import { nodeHref } from "@/lib/shell/sitemap";
import type { RecordState } from "@xos/ui";

/**
 * Requisitions turned into opportunities (Section 4.4.4 stage 1, Section 4.5.5): the org's staffing requisitions from
 * the People module (A03's 0361), with how many postings each already published from. Only an Approved requisition posts;
 * spend authority runs on the requisition, so publishing never bypasses it (migration 0774).
 */
export default async function RequisitionsPage({
  params,
  searchParams,
}: PageProps<"/[org]/opportunities/requisitions">) {
  const routeParams = await params;
  const page = await setupPage(
    "opportunities.requisitions",
    routeParams,
    (await searchParams) as SearchParams,
  );
  const { ctx, t } = page;
  const requisitions = must(await listRequisitions(ctx.viewer.db, ctx.org.id), "requisitions");
  const postings = nodeHref("opportunities.postings", routeParams) ?? page.base;
  const canPost = ctx.capabilities.has("opportunities.posting.write");
  const people = nodeHref("people.requisitions", routeParams);

  return (
    <TemplateCollection
      header={
        <PageHeader
          title={t("requisitions.title")}
          count={requisitions.length}
          views={
            <ViewSwitch
              label={t("views.label")}
              views={page.views}
              current={page.view}
              hrefFor={(v) => page.href({ view: v })}
            />
          }
          actions={people ? <ButtonLink href={people}>{t("requisitions.raise")}</ButtonLink> : null}
        />
      }
    >
      {requisitions.length === 0 ? (
        <EmptyStateLink
          icon="ClipboardList"
          sentence={t("requisitions.empty")}
          actionLabel={t("requisitions.emptyAction")}
          href={people ?? postings}
        />
      ) : page.view === "board" ? (
        <RequisitionBoard page={page} rows={requisitions} postings={postings} canPost={canPost} />
      ) : (
        <RequisitionTable page={page} rows={requisitions} postings={postings} canPost={canPost} />
      )}
    </TemplateCollection>
  );
}

function stateIcon(state: Requisition["state"]): RecordState {
  switch (state) {
    case "Proposed":
      return "in-review";
    case "Approved":
      return "ready";
    case "Filled":
      return "complete";
    case "Rejected":
    case "Canceled":
      return "canceled";
    default:
      return "proposed";
  }
}

function PostLink({
  page,
  r,
  postings,
  canPost,
}: {
  page: PageSetup;
  r: Requisition;
  postings: string;
  canPost: boolean;
}) {
  if (!canPost) return null;
  if (r.state !== "Approved")
    return (
      <span className="text-text-12 text-text-secondary">
        {page.t("requisitions.awaitingApproval")}
      </span>
    );
  return (
    <RowLink href={`${postings}?create=1&requisition=${r.id}`}>
      {page.t("requisitions.post")}
    </RowLink>
  );
}

function RequisitionTable({
  page,
  rows,
  postings,
  canPost,
}: {
  page: PageSetup;
  rows: readonly Requisition[];
  postings: string;
  canPost: boolean;
}) {
  const { t } = page;
  return (
    <Table
      caption={t("requisitions.title")}
      rowKey={(r) => r.id}
      rows={rows}
      columns={[
        {
          key: "role",
          label: t("fields.role"),
          cell: (r) => (
            <span>
              {r.jobTitle ?? r.roleCode}{" "}
              <span className="font-mono text-text-12 text-text-secondary">{r.roleCode}</span>
            </span>
          ),
        },
        {
          key: "state",
          label: t("fields.state"),
          cell: (r) => (
            <StateChip
              state={stateIcon(r.state)}
              label={t(`requisitionStates.${enumKey(r.state)}`)}
              compact
            />
          ),
        },
        {
          key: "action",
          label: t("fields.next"),
          cell: (r) => <PostLink page={page} r={r} postings={postings} canPost={canPost} />,
        },
        { key: "project", label: t("fields.project"), cell: (r) => r.projectKey },
        { key: "headcount", label: t("fields.headcount"), numeric: true, cell: (r) => r.headcount },
        {
          key: "rate",
          label: t("fields.rate"),
          cell: (r) => formatMoney(page.locale, r.rateMinor, r.currencyCode) ?? t("unpriced"),
        },
        {
          key: "postings",
          label: t("fields.postings"),
          numeric: true,
          cell: (r) => r.opportunityCount,
        },
      ]}
    />
  );
}

function RequisitionBoard({
  page,
  rows,
  postings,
  canPost,
}: {
  page: PageSetup;
  rows: readonly Requisition[];
  postings: string;
  canPost: boolean;
}) {
  const { t } = page;
  const states = ["Proposed", "Approved", "Filled", "Rejected", "Canceled"] as const;
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-12">
      {states.map((s) => {
        const cards = rows.filter((r) => r.state === s);
        return (
          <section
            key={s}
            aria-label={t(`requisitionStates.${enumKey(s)}`)}
            className="flex flex-col gap-8 rounded-card bg-bg-surface p-8"
          >
            <h2 className="m-0 flex items-center justify-between text-label-13 font-semibold">
              {t(`requisitionStates.${enumKey(s)}`)}{" "}
              <span className="text-text-secondary tabular-nums">{cards.length}</span>
            </h2>
            {cards.length === 0 ? <Muted>{t("board.emptyColumn")}</Muted> : null}
            <ul className="m-0 flex list-none flex-col gap-8 p-0">
              {cards.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-col gap-4 rounded-card border border-border-subtle bg-bg-raised p-8 text-text-13"
                >
                  <span className="font-medium">{r.jobTitle ?? r.roleCode}</span>
                  <span className="text-text-12 text-text-secondary">
                    {r.projectKey} · {t("requisitions.headcount", { count: r.headcount })}
                  </span>
                  <PostLink page={page} r={r} postings={postings} canPost={canPost} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
