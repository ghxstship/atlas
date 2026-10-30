import type { ReactNode } from "react";

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

export interface TemplateSplitViewProps {
  list: ReactNode;
  detail: ReactNode;
  /** List width in pixels; resizable between 240 and 480. */
  listWidth?: number;
  listLabel?: string;
}

/** One tile on the dashboard grid. */
export interface DashboardTile {
  /** Stable id; a saved layout names tiles by it. */
  id: string;
  /** Names the tile for its resize handle and announcements. */
  label: string;
  /** Columns of the 12-column grid the tile spans by default. */
  span: number;
  /** The fewest columns it may shrink to; 3 by default. */
  minSpan?: number;
  /** StatTile, Chart or Card content. */
  content: ReactNode;
}

/** Spans by tile id, as a person arranged them. */
export type DashboardSpans = Readonly<Record<string, number>>;

/**
 * Resizing in grid units. Copy arrives from the app, so the library ships no strings for it; without
 * this prop tiles keep their spans.
 */
export interface DashboardResize {
  /** The handle's name, such as "Resize Alerts". */
  label: (tile: string) => string;
  /** What a screen reader hears after a change, such as "Alerts, 6 of 12 columns". */
  describe: (tile: string, span: number) => string;
  /** Called with every tile's span once a drag ends or a key changes one. */
  onChange: (spans: DashboardSpans) => void;
}

export interface TemplateDashboardProps {
  /** PageHeader with the title. */
  header: ReactNode;
  /** The date range and scope picker, at the end of the header row. */
  controls?: ReactNode;
  /** Tiles on the 12-column grid, in reading order. */
  tiles?: readonly DashboardTile[];
  /** The person's saved spans; a tile without one keeps its default. */
  spans?: DashboardSpans;
  resize?: DashboardResize;
  /** Names the grid for assistive technology. */
  label?: string;
  /** Free content on the grid; each child spans 4 columns at lg. */
  children?: ReactNode;
}

export interface TemplateSettingsProps {
  /** The section list. */
  sections: ReactNode;
  /** The form column, 640 px at most. */
  children: ReactNode;
  /** A sticky save bar shown while there are unsaved changes. */
  saveBar?: ReactNode;
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

export interface TemplateGridEditorProps {
  header: ReactNode;
  /** SpreadsheetGrid, BudgetGrid or AccessGridMatrix. */
  children: ReactNode;
  toolbar?: ReactNode;
}

export interface TemplateDocumentProps {
  /** The outline, hidden below lg. */
  outline: ReactNode;
  children: ReactNode;
  /** Required acknowledgments at the end of the document. */
  acknowledgments?: ReactNode;
}

export interface TemplateAuthProps {
  brand?: ReactNode;
  children: ReactNode;
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

export interface TemplateSystemProps {
  icon: string;
  title: string;
  sentence: string;
  actionLabel: string;
  onAction?: () => void;
  /** A support reference such as an error id. */
  reference?: string;
}
