"use client";

/**
 * The client boundary for the @xos/ui components the Finance and Reports server components render
 * (A15). Their modules use hooks and context, so server components import them from here.
 */
export {
  CoordinateMatrix,
  PageHeader,
  PropertyList,
  StateChip,
  TemplateCollection,
  TemplateDashboard,
  TemplateGridEditor,
  TemplateRecord,
} from "@xos/ui";
export { RefusalNotice } from "@/components/refusal-notice";
