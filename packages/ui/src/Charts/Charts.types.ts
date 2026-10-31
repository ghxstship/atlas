import type {
  CalendarProps as ReferenceCalendarProps,
  GalleryProps as ReferenceGalleryProps,
  OrgChartProps as ReferenceOrgChartProps,
  ResourceScheduleProps as ReferenceResourceScheduleProps,
  TimelineChange as ReferenceTimelineChange,
  TimelineLink as ReferenceTimelineLink,
  TimelinePreview as ReferenceTimelinePreview,
  TimelineProps as ReferenceTimelineProps,
} from "../types/reference";
import type { ItemSelection } from "../lib/selection.ts";
import type { ItemContextMenu } from "../Views/Views.types.ts";

export type GalleryProps = ReferenceGalleryProps;

type CalendarEvent = ReferenceCalendarProps["events"][number] & {
  /** How the selection, menus and hover cards name the event (`data-item`). */
  id?: string;
};

export type CalendarProps = Omit<ReferenceCalendarProps, "events"> & {
  events: CalendarEvent[];
  onEventSelect?: (event: CalendarEvent) => void;
  /** Events with an `id` can be selected. See useItemSelection. */
  selection?: ItemSelection;
  onItemContextMenu?: ItemContextMenu;
};

export type TimelineProps = ReferenceTimelineProps;
export type TimelineChange = ReferenceTimelineChange;
export type TimelineLink = ReferenceTimelineLink;
export type TimelinePreview = ReferenceTimelinePreview;

export type ResourceScheduleProps = ReferenceResourceScheduleProps;

export type OrgChartProps = ReferenceOrgChartProps;
