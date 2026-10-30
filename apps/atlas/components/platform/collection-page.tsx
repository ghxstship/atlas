import type { ReactNode } from "react";
import { TemplateCollection } from "@/components/platform/client/template-collection";

/**
 * A server-rendered section on the Collection template (Section 11.6, A129): its page header, then the
 * rest of the section (filters, forms, the view, a side peek) spaced as the app shell spaces a page.
 * For sections that build their parts on the server and would otherwise stand on no template.
 */
export function CollectionPage({
  header,
  gap = 16,
  children,
}: {
  header: ReactNode;
  /** Space between the section's parts: 16 px as the shell spaces a page, 12 px for a dense one. */
  gap?: 12 | 16;
  children: ReactNode;
}) {
  return (
    <TemplateCollection header={header}>
      <div className={`flex flex-col min-w-0 ${gap === 12 ? "gap-12" : "gap-16"}`}>{children}</div>
    </TemplateCollection>
  );
}
