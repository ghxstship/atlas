import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The System template (Section 11.6): a centered message, an icon from the set and one primary
 * action. Empty states use the same frame with one sentence and one button (Section 11.10, 10).
 * Stands in for @xos/ui TemplateSystem and EmptyState until they land on main.
 */
export function SystemMessage({
  icon: Icon,
  title,
  body,
  action,
  headingLevel = 1,
}: {
  icon: LucideIcon;
  title?: string;
  body: string;
  action: ReactNode;
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section className="mx-auto flex max-w-layout-form flex-col items-center gap-16 px-24 py-64 text-center">
      <Icon aria-hidden="true" className="size-48 text-text-tertiary" strokeWidth={1.5} />
      {title ? (
        <Heading className="text-heading-20 font-semibold text-text-primary">{title}</Heading>
      ) : null}
      <p className="text-text-14 text-text-secondary">{body}</p>
      <div>{action}</div>
    </section>
  );
}
