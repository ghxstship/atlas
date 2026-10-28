"use client";

import dynamic from "next/dynamic";

/**
 * Crew client components a page renders only in some states: the table and calendar views, the
 * side peek with its comments and attachments, a create or edit drawer, and the quick add row. Server components that
 * render them conditionally go through next/dynamic, so their code loads when they render (ADR 0027,
 * A24-009). Pages that render one by default import it directly.
 */
export const CrewCollab = dynamic(() => import("./collab").then((m) => m.CrewCollab));
export const DrawerForm = dynamic(() => import("./forms-drawer-form").then((m) => m.DrawerForm));
export const PeekCalendar = dynamic(() =>
  import("./views-peek-calendar").then((m) => m.PeekCalendar),
);
export const PeekPanel = dynamic(() => import("./views-peek-panel").then((m) => m.PeekPanel));
export const PeekTable = dynamic(() => import("./views-peek-table").then((m) => m.PeekTable));
export const ShiftQuickAdd = dynamic(() =>
  import("@/components/quick-add/shift-quick-add").then((m) => m.ShiftQuickAdd),
);
