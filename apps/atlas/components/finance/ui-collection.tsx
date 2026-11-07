"use client";

/**
 * The client boundary for the @xos/ui templates a Finance list renders (A15). It stays apart from ui.tsx, because a
 * boundary ships every export it has: the record and dashboard templates load only with the pages that show them.
 */
export { PageHeader, TemplateCollection, TemplateGridEditor } from "@xos/ui";
