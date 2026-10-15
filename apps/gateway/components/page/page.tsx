import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { LoadError } from "@/components/ui";
export { SectionTabs } from "./section-tabs";
import type { NavLink } from "@/lib/shell/nav-model";

/**
 * Page building blocks for the Gateway shell template: the page title with one primary action,
 * the section tabs under a destination (Work, Money, Explore and the engagement tabs, all from the
 * sitemap) and the view switcher, which offers only the views the sitemap lists for the page.
 */

export function PageTitle({
  title,
  lead,
  action,
  eyebrow,
}: {
  title: string;
  lead?: ReactNode;
  action?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-12">
      <div className="flex min-w-0 flex-col gap-4">
        {eyebrow ? <div className="text-text-12 text-text-secondary">{eyebrow}</div> : null}
        <h1 className="m-0 text-heading-20 font-semibold">{title}</h1>
        {lead ? (
          <p className="m-0 max-w-layout-reading text-text-14 text-text-secondary">{lead}</p>
        ) : null}
      </div>
      {action ? <div className="flex flex-none items-center gap-8">{action}</div> : null}
    </header>
  );
}

/** Page tabs from the sitemap children of a destination, labels translated. */
export function childTabLinks(
  tabs: readonly NavLink[],
  t: (key: string) => string,
): { id: string; label: string; href: string }[] {
  return tabs.map((tab) => ({ id: tab.id, label: t(tab.label), href: tab.href }));
}

/** The view switcher: links that keep every other query parameter (Section 11.15). */
export async function ViewSwitcher({
  views,
  current,
  path,
  query,
}: {
  views: readonly string[];
  current: string;
  path: string;
  query: Readonly<Record<string, string | string[] | undefined>>;
}) {
  if (views.length < 2) return null;
  const t = await getTranslations("gateway.common");
  const tr = t as unknown as (key: string, values?: Record<string, string>) => string;
  return (
    <div
      role="group"
      aria-label={tr("viewAs", { view: tr(`views.${current}`) })}
      className="inline-flex gap-4"
    >
      {views.map((view) => {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(query))
          if (typeof v === "string" && k !== "view") params.set(k, v);
        params.set("view", view);
        const selected = view === current;
        return (
          <Link
            key={view}
            href={`${path}?${params.toString()}` as Route}
            aria-current={selected ? "true" : undefined}
            className={`inline-flex min-h-touch-min items-center rounded-control px-12 text-text-13 font-medium no-underline ${
              selected ? "bg-bg-hover text-text-primary" : "text-text-secondary hover:bg-bg-hover"
            }`}
          >
            {tr(`views.${view}`)}
          </Link>
        );
      })}
    </div>
  );
}

/** The view a list page shows: the requested one when the sitemap lists it, else the default. */
export function pickView(
  requested: string | string[] | undefined,
  views: readonly string[],
  fallback: string,
): string {
  return typeof requested === "string" && views.includes(requested) ? requested : fallback;
}

/** The region error state with its retry, for a read that failed (Section 11.7). */
export async function RegionError() {
  const t = await getTranslations("gateway.common.loadError");
  return <LoadError title={t("title")} sentence={t("body")} actionLabel={t("action")} />;
}

/** A titled section of a page. */
export function Section({
  title,
  children,
  action,
  id,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  id?: string;
}) {
  const headingId = id ?? `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-12">
      <div className="flex items-center justify-between gap-8">
        <h2 id={headingId} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
