import type { ReactElement, ReactNode } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { ResizablePanel, Stepper } from "../Layout/Layout.tsx";

/*
 * Page templates (design reference, Templates group). Each is a layout with named slots; the screens
 * compose components into the slots. Every template collapses to one column on small screens, and
 * the order of the source is the reading order.
 */

export interface TemplateCollectionProps {
  /** PageHeader: title, count, view switcher and the one primary action. */
  header: ReactNode;
  /** FilterBuilder or saved filters. */
  filters?: ReactNode;
  /** The view body: RecordList, DataTable, Board, Timeline or Calendar. */
  children: ReactNode;
  /** A SidePeek for the selected record. */
  peek?: ReactNode;
  /** BulkActionBar while records are selected. */
  bulk?: ReactNode;
}

/** Every list, board, timeline, calendar and table. */
export function TemplateCollection({
  header,
  filters,
  children,
  peek,
  bulk,
}: TemplateCollectionProps): ReactElement {
  return (
    <div className="flex flex-col gap-12 min-w-0">
      {header}
      {filters ? <div className="flex flex-wrap items-center gap-6">{filters}</div> : null}
      <div className="min-w-0">{children}</div>
      {bulk ? (
        <div className="sticky bottom-16 flex justify-center print:hidden">{bulk}</div>
      ) : null}
      {peek}
    </div>
  );
}

export interface TemplateRecordProps {
  /** Title row: key, kind, state and actions. */
  header: ReactNode;
  /** Content and activity. */
  children: ReactNode;
  /** The 320 px property column. */
  properties: ReactNode;
  related?: ReactNode;
  /** Names the property column for assistive technology. */
  propertiesLabel?: string;
}

/** Every record full page: content and activity beside the 320 px property column. */
export function TemplateRecord({
  header,
  children,
  properties,
  related,
  propertiesLabel,
}: TemplateRecordProps): ReactElement {
  return (
    <article className="flex flex-col gap-16 min-w-0">
      {header}
      <div className="grid grid-cols-[minmax(0,1fr)_var(--layout-property-column)] max-lg:grid-cols-[minmax(0,1fr)] gap-24">
        <div className="flex flex-col gap-16 min-w-0">{children}</div>
        <aside
          aria-label={propertiesLabel}
          className={cx(
            "min-w-0 ps-20 border-s border-border-subtle",
            "max-lg:ps-0 max-lg:border-s-0 max-lg:pt-16 max-lg:border-t",
          )}
        >
          {properties}
        </aside>
      </div>
      {related ? <section className="min-w-0">{related}</section> : null}
    </article>
  );
}

export interface TemplateSplitViewProps {
  list: ReactNode;
  detail: ReactNode;
  /** List width in pixels; resizable between 240 and 480. */
  listWidth?: number;
  listLabel?: string;
}

/** A resizable list beside the selected record: Inbox, Dispatch, Advancing, Import review. */
export function TemplateSplitView({
  list,
  detail,
  listWidth = 300,
  listLabel,
}: TemplateSplitViewProps): ReactElement {
  return (
    <div className="flex gap-16 min-w-0 max-lg:flex-col">
      <div className="max-lg:[&>div]:w-full! max-lg:[&_[role=separator]]:hidden">
        <ResizablePanel
          initial={listWidth}
          min={240}
          max={480}
          {...(listLabel ? { label: listLabel } : {})}
        >
          {list}
        </ResizablePanel>
      </div>
      <div className="flex-1 min-w-0">{detail}</div>
    </div>
  );
}

export interface TemplateDashboardProps {
  /** Title with the date range and scope picker. */
  header: ReactNode;
  /** StatTile, Chart and Card tiles on the grid. */
  children: ReactNode;
}

/** Home, report dashboards and the partner console: tiles on the grid, three columns at lg. */
export function TemplateDashboard({ header, children }: TemplateDashboardProps): ReactElement {
  return (
    <div className="flex flex-col gap-16 min-w-0">
      {header}
      <div className="grid grid-cols-3 max-lg:grid-cols-2 max-sm:grid-cols-1 gap-(--layout-gutter-lg)">
        {children}
      </div>
    </div>
  );
}

export interface TemplateSettingsProps {
  /** The section list. */
  sections: ReactNode;
  /** The form column, 640 px at most. */
  children: ReactNode;
  /** A sticky save bar shown while there are unsaved changes. */
  saveBar?: ReactNode;
}

/** Org, personal and project settings: sections beside a centered form column. */
export function TemplateSettings({
  sections,
  children,
  saveBar,
}: TemplateSettingsProps): ReactElement {
  return (
    <div className="grid grid-cols-[var(--ui-settings-nav)_minmax(0,var(--layout-form))] max-md:grid-cols-[minmax(0,1fr)] gap-32 max-md:gap-16">
      <div className="min-w-0">{sections}</div>
      <div className="flex flex-col gap-16 min-w-0">
        {children}
        {saveBar ? (
          <div className="sticky bottom-0 flex items-center justify-end gap-8 py-12 bg-bg-canvas border-t border-border-subtle">
            {saveBar}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export interface TemplateWizardProps {
  steps: string[];
  current: number;
  title: ReactNode;
  children: ReactNode;
  onBack?: () => void;
  onNext?: () => void;
  /** Label of the last step's button; Done by default. */
  finishLabel?: string;
  nextDisabled?: boolean;
}

/** Multi-step creation: a stepper, one step per page, Back and Next. */
export function TemplateWizard({
  steps,
  current,
  title,
  children,
  onBack,
  onNext,
  finishLabel,
  nextDisabled = false,
}: TemplateWizardProps): ReactElement {
  const t = useT();
  const last = current >= steps.length - 1;
  return (
    <div className="flex flex-col gap-24 w-full max-w-(--layout-form) mx-auto">
      <Stepper steps={steps} current={current} />
      <section className="flex flex-col gap-16">
        <h1 className="m-0 text-heading-20 font-semibold">{title}</h1>
        <p className="m-0 text-text-secondary tabular-nums">
          {t("count.step", { n: current + 1, total: steps.length })}
        </p>
        {children}
      </section>
      <div className="flex justify-between gap-8">
        <Button variant="ghost" icon="ChevronLeft" disabled={current === 0} onClick={onBack}>
          {t("nav.previous")}
        </Button>
        <Button variant="primary" disabled={nextDisabled} onClick={onNext}>
          {last ? (finishLabel ?? t("action.done")) : t("nav.next")}
        </Button>
      </div>
    </div>
  );
}

export interface TemplateGridEditorProps {
  header: ReactNode;
  /** SpreadsheetGrid, BudgetGrid or AccessGridMatrix. */
  children: ReactNode;
  toolbar?: ReactNode;
}

/** Spreadsheet-speed editing: a full-width grid under its header. */
export function TemplateGridEditor({
  header,
  children,
  toolbar,
}: TemplateGridEditorProps): ReactElement {
  return (
    <div className="flex flex-col gap-12 min-w-0">
      {header}
      {toolbar ? <div className="flex flex-wrap items-center gap-8">{toolbar}</div> : null}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export interface TemplateDocumentProps {
  /** The outline, hidden below lg. */
  outline: ReactNode;
  children: ReactNode;
  /** Required acknowledgments at the end of the document. */
  acknowledgments?: ReactNode;
}

/** SOPs, documents and legal pages: a 720 px reading column beside its outline. */
export function TemplateDocument({
  outline,
  children,
  acknowledgments,
}: TemplateDocumentProps): ReactElement {
  return (
    <div className="grid grid-cols-[var(--ui-outline)_minmax(0,var(--layout-reading))] max-lg:grid-cols-[minmax(0,1fr)] gap-32">
      <div className="max-lg:hidden">{outline}</div>
      <article className="flex flex-col gap-16 min-w-0 leading-relaxed">
        {children}
        {acknowledgments ? (
          <footer className="pt-16 border-t border-border-subtle">{acknowledgments}</footer>
        ) : null}
      </article>
    </div>
  );
}

export interface TemplateAuthProps {
  brand?: ReactNode;
  children: ReactNode;
}

/** Sign in, MFA, invite acceptance and passkey setup: a centered 400 px card. */
export function TemplateAuth({ brand, children }: TemplateAuthProps): ReactElement {
  return (
    <div className="grid place-items-center min-h-full p-24 bg-bg-canvas">
      <div className="flex flex-col gap-24 w-[min(var(--layout-auth),100%)]">
        {brand ? <div className="flex justify-center">{brand}</div> : null}
        <div className="flex flex-col gap-16 p-24 bg-bg-raised border border-border-subtle rounded-card">
          {children}
        </div>
      </div>
    </div>
  );
}

export interface TemplateGatewayShellProps {
  /** TopNav on desktop. */
  topNav: ReactNode;
  /** Up Next and the side column, beside the feed on desktop. */
  aside?: ReactNode;
  children: ReactNode;
  /** TabBar below md. */
  tabBar?: ReactNode;
}

/** Every Gateway page: top navigation, no sidebar, comfortable density and 14 px base text. */
export function TemplateGatewayShell({
  topNav,
  aside,
  children,
  tabBar,
}: TemplateGatewayShellProps): ReactElement {
  return (
    <div className="flex flex-col min-h-full bg-bg-canvas text-text-14">
      <div className="max-md:hidden">{topNav}</div>
      <main
        className={cx(
          "flex-1 p-24 max-md:p-16 min-w-0",
          aside
            ? "grid grid-cols-[var(--ui-gateway-aside)_minmax(0,1fr)] max-lg:grid-cols-[minmax(0,1fr)] gap-24"
            : "flex flex-col gap-16",
        )}
      >
        {aside ? <div className="flex flex-col gap-16 min-w-0">{aside}</div> : null}
        <div className="flex flex-col gap-16 min-w-0">{children}</div>
      </main>
      {tabBar ? (
        <div className="hidden max-md:block sticky bottom-0 [&_nav]:w-full">{tabBar}</div>
      ) : null}
    </div>
  );
}

export interface TemplateSystemProps {
  icon: string;
  title: string;
  sentence: string;
  actionLabel: string;
  onAction?: () => void;
  /** A support reference such as an error id. */
  reference?: string;
}

/** 404, 500, maintenance, offline and archived org: a centered message and one primary action. */
export function TemplateSystem({
  icon,
  title,
  sentence,
  actionLabel,
  onAction,
  reference,
}: TemplateSystemProps): ReactElement {
  return (
    <div className="flex flex-col items-center gap-12 py-48 px-16 text-center">
      <span className="text-text-secondary">
        <Icon name={icon} size={28} />
      </span>
      <h1 className="m-0 text-heading-20 font-semibold">{title}</h1>
      <p className="m-0 max-w-(--layout-auth) text-text-secondary">{sentence}</p>
      <Button variant="primary" onClick={onAction}>
        {actionLabel}
      </Button>
      {reference ? (
        <span className="font-mono text-text-12 text-text-secondary">{reference}</span>
      ) : null}
    </div>
  );
}
