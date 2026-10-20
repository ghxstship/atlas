import { type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { type BreadcrumbsProps } from "./Navigation.types.ts";

/** One crumb's text: shrinks with an ellipsis when the trail runs out of room, titled in full. */
const LABEL = "block truncate";

/**
 * Org, workspace, project, scope node, module and record; the last is the current page. The trail
 * stays on one line: in a narrow header (a phone's top bar) or under a longer translation each crumb
 * shrinks with an ellipsis and keeps its whole label as a title, instead of wrapping out of the
 * header's height (Section 15, gate 16).
 */
export function Breadcrumbs({ items }: BreadcrumbsProps): ReactElement {
  const t = useT();
  return (
    <nav aria-label={t("nav.breadcrumb")} className="min-w-0">
      <ol className="flex items-center gap-4 m-0 p-0 list-none text-text-13 text-text-secondary max-w-full min-w-0">
        {items.map((it, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${it.label}-${i}`} className="inline-flex items-center gap-4 min-w-0">
              {last ? (
                <span aria-current="page" className={`${LABEL} text-text-primary`} title={it.label}>
                  {it.label}
                </span>
              ) : it.href ? (
                <a
                  href={it.href}
                  className="xos-hit min-w-0 text-inherit no-underline hover:text-text-primary"
                >
                  <span className={LABEL} title={it.label}>
                    {it.label}
                  </span>
                </a>
              ) : (
                <span className={LABEL} title={it.label}>
                  {it.label}
                </span>
              )}
              {last ? null : (
                <span className="shrink-0 text-text-tertiary">
                  <Icon name="chevron-right" size={12} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
