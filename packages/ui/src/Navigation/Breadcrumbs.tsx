import { type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { type BreadcrumbsProps } from "./Navigation.types.ts";

/** Org, workspace, project, scope node, module and record; the last is the current page. */
export function Breadcrumbs({ items }: BreadcrumbsProps): ReactElement {
  const t = useT();
  return (
    <nav aria-label={t("nav.breadcrumb")}>
      <ol className="flex flex-wrap items-center gap-4 m-0 p-0 list-none text-text-13 text-text-secondary max-w-full">
        {items.map((it, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${it.label}-${i}`} className="inline-flex items-center gap-4">
              {last ? (
                <span aria-current="page" className="text-text-primary">
                  {it.label}
                </span>
              ) : it.href ? (
                <a
                  href={it.href}
                  className="xos-hit text-inherit no-underline hover:text-text-primary"
                >
                  {it.label}
                </a>
              ) : (
                <span>{it.label}</span>
              )}
              {last ? null : (
                <span className="text-text-tertiary">
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
