import type {
  CalendarProps as ReferenceCalendarProps,
  GalleryProps as ReferenceGalleryProps,
  OrgChartProps as ReferenceOrgChartProps,
  ResourceScheduleProps as ReferenceResourceScheduleProps,
  TimelineProps as ReferenceTimelineProps,
} from "../types/reference";

export type GalleryProps = ReferenceGalleryProps;

export type CalendarProps = ReferenceCalendarProps & {
  onEventSelect?: (event: ReferenceCalendarProps["events"][number]) => void;
};

export type TimelineProps = ReferenceTimelineProps;

export type ResourceScheduleProps = ReferenceResourceScheduleProps;

export type OrgChartProps = ReferenceOrgChartProps;
