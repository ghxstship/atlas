"use client";

/**
 * The client boundary for the @xos/ui components the Places and Safety pages use. Server components
 * import them from here, never from "@xos/ui" directly, because the library uses hooks and context.
 */
export {
  AssertionRankBadge,
  Badge,
  Calendar,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Gallery,
  InlineAlert,
  MapView,
  PageHeader,
  PropertyList,
  ReconciliationTable,
  RefusalNotice,
  Skeleton,
  StalenessIndicator,
  StateChip,
  Tag,
  TemplateCollection,
  TemplateRecord,
  URIDChip,
} from "@xos/ui";
