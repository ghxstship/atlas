import type { ReactElement } from "react";
import { type TemplateDocumentProps } from "./Templates.types.ts";

/** SOPs, documents and legal pages: a 720 px reading column beside its outline. */
export function TemplateDocument({
  outline,
  children,
  acknowledgments,
}: TemplateDocumentProps): ReactElement {
  return (
    <div
      data-template="document"
      className="grid grid-cols-[var(--ui-outline)_minmax(0,var(--layout-reading))] max-lg:grid-cols-[minmax(0,1fr)] gap-32"
    >
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
