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

export interface TemplateDashboardProps {
  /** Title with the date range and scope picker. */
  header: ReactNode;
  /** StatTile, Chart and Card tiles on the grid. */
  children: ReactNode;
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

/** TemplateSystem whose action is a link, for server components (`@xos/ui/static`). */
export interface TemplateSystemLinkProps extends Omit<TemplateSystemProps, "onAction"> {
  /** Where the action goes. */
  href: string;
}
