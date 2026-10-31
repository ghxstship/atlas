import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyStateLink, Tag } from "@/components/ui";
import { closedArea, tabHref } from "@/lib/engagement";
import type { Tone } from "@/lib/states";
import type { TabProps } from "./tab-context";

/**
 * Engagement tab building blocks. Every list row answers "what now" (Section 11.10, rule 4): its
 * title, the facts that matter, its state and, when the person has something to do, the action
 * itself. Empty tabs say why they are empty and name the next step.
 */
export interface RowItem {
  readonly id: string;
  readonly title: string;
  readonly meta?: readonly (string | null | undefined | false)[];
  readonly tag?: { readonly label: string; readonly tone: Tone };
  readonly action?: ReactNode;
  readonly href?: string;
  /** Extra content under the row, such as line items or an answer form. */
  readonly detail?: ReactNode;
  /** Changed since the person last looked (B6, the itinerary): an accent tag that names the fields. */
  readonly changed?: { readonly label: string };
}

export function RowList({ items, label }: { items: readonly RowItem[]; label: string }) {
  return (
    <ul
      aria-label={label}
      className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle bg-bg-raised p-0"
    >
      {items.map((item) => {
        const meta = (item.meta ?? []).filter(
          (m): m is string => typeof m === "string" && m.length > 0,
        );
        return (
          <li key={item.id} className="flex flex-col gap-8 px-16 py-12">
            <div className="flex flex-wrap items-center gap-x-12 gap-y-6">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                {item.href ? (
                  <Link href={item.href as Route} className="font-medium text-text-primary">
                    {item.title}
                  </Link>
                ) : (
                  <span className="font-medium">{item.title}</span>
                )}
                {meta.length > 0 ? (
                  <span className="text-text-13 text-text-secondary">{meta.join(" · ")}</span>
                ) : null}
              </div>
              {item.changed ? <Tag tone="accent">{item.changed.label}</Tag> : null}
              {item.tag ? <Tag tone={item.tag.tone}>{item.tag.label}</Tag> : null}
              {item.action}
            </div>
            {item.detail}
          </li>
        );
      })}
    </ul>
  );
}

/** A tab with nothing to show yet: one sentence and one action (Section 11.10, rule 10). */
export function TabEmpty({
  icon,
  sentence,
  actionLabel,
  href,
}: {
  icon: string;
  sentence: string;
  actionLabel: string;
  href: string;
}) {
  return <EmptyStateLink icon={icon} sentence={sentence} actionLabel={actionLabel} href={href} />;
}

/**
 * A time-boxed section that is not open (Section 8.7): before Active it names the way there; after
 * Complete or Canceled it says the section has closed and links to what stays open.
 */
export function AreaClosed({
  view,
  t,
  engagementKey,
}: Pick<TabProps, "view" | "t" | "engagementKey">) {
  const closed = closedArea(view.engagement.state, view.tabs);
  return (
    <TabEmpty
      icon="Lock"
      sentence={t(closed.sentence)}
      actionLabel={t(closed.action)}
      href={tabHref(engagementKey, closed.tab)}
    />
  );
}
