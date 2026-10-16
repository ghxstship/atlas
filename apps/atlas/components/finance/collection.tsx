import type { DataTableColumn, RecordState } from "@xos/ui";
import type { ReactNode } from "react";
import { withQuery, type FinancePage } from "@/lib/finance/context";
import {
  BackToList,
  CollectionBoard,
  CollectionList,
  CollectionTable,
  CreateButton,
  FilterBar,
  RecordPeek,
  ViewSwitcher,
  type BoardColumn,
  type ListItem,
  type Option,
  type Row,
} from "./kit";
import { EmptyPanel, ErrorPanel, RefusalPanel } from "./panels";
import { PageHeader, PropertyList, StateChip, TemplateCollection, TemplateRecord } from "./ui";

/**
 * The Collection template for finance documents (Section 11.6): header with count, view switcher and
 * the one primary action; filters; the table, list or board body; the record as a peek beside the
 * list or as the full page (`&full=1`); and the create or edit sheet. Every view keeps the filters,
 * because they live in the query string (Section 11.15).
 */

export interface RecordDetail {
  readonly kindLabel: string;
  readonly recordKey: string;
  readonly title: string;
  readonly state: RecordState;
  readonly stateLabel: string;
  readonly properties: { label: string; value: ReactNode }[];
  /** Actions, lines, activity, comments and attachments. */
  readonly content: ReactNode;
  readonly propertiesLabel: string;
}

export function FinanceCollection({
  page,
  title,
  createLabel,
  canCreate,
  refusal,
  error,
  count,
  states,
  columns,
  rows,
  listItems,
  board,
  empty,
  detail,
  sheet,
  above,
}: {
  page: FinancePage;
  title: string;
  createLabel?: string;
  canCreate: boolean;
  /** The capability the viewer lacks, when the page refuses. */
  refusal?: string | null;
  /** Error copy when the page's data failed to load. */
  error?: string | null;
  count: number;
  states?: readonly Option[];
  columns: DataTableColumn[];
  rows: readonly Row[];
  listItems?: readonly ListItem[];
  board?: readonly BoardColumn[];
  /** Empty copy: one sentence and the action that fills the page; `noMatches` when filters hide every row. */
  empty: {
    sentence: string;
    actionLabel: string;
    noMatches: string;
    clearLabel: string;
    icon?: string;
  };
  detail?: RecordDetail | null;
  sheet?: ReactNode;
  above?: ReactNode;
}) {
  const { query } = page;
  const header = (
    <PageHeader
      title={title}
      {...(refusal || error ? {} : { count })}
      views={refusal || error ? undefined : <ViewSwitcher views={page.views} value={page.view} />}
      actions={
        canCreate && createLabel && !refusal ? <CreateButton label={createLabel} /> : undefined
      }
    />
  );
  if (refusal) {
    return (
      <TemplateCollection header={header}>
        <RefusalPanel capability={refusal} href={`/${page.ctx.org.slug}/home`} />
      </TemplateCollection>
    );
  }
  if (error) {
    return (
      <TemplateCollection header={header}>
        <ErrorPanel sentence={error} />
      </TemplateCollection>
    );
  }
  if (detail && query.full) {
    return (
      <TemplateRecord
        propertiesLabel={detail.propertiesLabel}
        header={
          <header className="flex flex-col gap-8 border-b border-border-subtle pb-12">
            <div>
              <BackToList />
            </div>
            <p className="m-0 flex items-center gap-6 text-text-12 text-text-secondary">
              <span>{detail.kindLabel}</span>
              <span className="font-mono">{detail.recordKey}</span>
            </p>
            <h1 className="m-0 text-heading-20 font-semibold">{detail.title}</h1>
            <div>
              <StateChip state={detail.state} label={detail.stateLabel} />
            </div>
          </header>
        }
        properties={<PropertyList items={detail.properties} />}
      >
        {detail.content}
        {sheet}
      </TemplateRecord>
    );
  }
  const projects = page.inProject
    ? undefined
    : page.projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` }));
  let body: ReactNode;
  if (rows.length === 0) {
    const filtered = Boolean(query.q || query.state || (query.project && !page.inProject));
    body = (
      <EmptyPanel
        icon={empty.icon ?? "Inbox"}
        sentence={filtered ? empty.noMatches : empty.sentence}
        actionLabel={filtered ? empty.clearLabel : empty.actionLabel}
        href={
          filtered
            ? withQuery(page, {
                q: null,
                state: null,
                ...(page.inProject ? {} : { project: null }),
              })
            : canCreate
              ? withQuery(page, { create: "1" })
              : `/${page.ctx.org.slug}/finance`
        }
      />
    );
  } else if (page.view === "list" && listItems) {
    body = <CollectionList label={title} items={listItems} />;
  } else if (page.view === "board" && board) {
    body = <CollectionBoard columns={board} />;
  } else {
    body = <CollectionTable label={title} columns={columns} rows={rows} />;
  }
  return (
    <TemplateCollection
      header={header}
      filters={
        <FilterBar
          projects={projects}
          project={query.project}
          states={states}
          state={query.state}
          q={query.q}
        />
      }
      peek={
        detail ? (
          <RecordPeek
            kindLabel={detail.kindLabel}
            recordKey={detail.recordKey}
            title={detail.title}
            state={detail.state}
            stateLabel={detail.stateLabel}
            properties={detail.properties}
          >
            {detail.content}
          </RecordPeek>
        ) : null
      }
    >
      {above}
      {body}
      {sheet}
    </TemplateCollection>
  );
}
