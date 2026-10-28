"use client";

import { Icon } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { searchGateway, type SearchResultGroup } from "@/lib/shell/search-actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Results stay with the text they answer, so a slow answer never replaces a newer one. */
interface Answer {
  readonly query: string;
  readonly groups: readonly SearchResultGroup[];
}

/**
 * Search first on the phone Home (Section 4.5.8, Section 11.10 item 1, A126). As the person types, their
 * own documents, conversations, engagements, opportunities, the actions and settings that match appear
 * under the field, from the same server search as the command menu (lib/shell/search-actions.ts). The
 * last link, and Enter, search every opportunity open to them on Explore; without JavaScript the form
 * does that alone.
 */
export function HomeSearch() {
  const t = useTranslations() as unknown as Translate;
  const id = useId();
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<Answer>({ query: "", groups: [] });
  const text = query.trim();

  useEffect(() => {
    if (text.length < 2) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void searchGateway({ query: text }).then(
        (groups) => {
          if (live) setAnswer({ query: text, groups });
        },
        () => {
          if (live) setAnswer({ query: text, groups: [] });
        },
      );
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [text]);

  const current = text.length >= 2 && answer.query === text;
  const groups = current ? answer.groups : [];
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  const explore = `/explore?q=${encodeURIComponent(text)}` as Route;

  return (
    <div className="flex flex-col gap-8">
      <form action="/explore" method="get" role="search" className="flex">
        <label className="flex min-h-touch-min w-full items-center gap-8 rounded-control border border-border-control bg-bg-surface ps-12 pe-8 focus-within:outline-solid focus-within:outline-stroke-focus focus-within:outline-focus-ring">
          <span className="text-text-secondary">
            <Icon name="Search" />
          </span>
          <span className="sr-only">{t("gatewaySearch.home.label")}</span>
          <input
            name="q"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("gatewaySearch.home.hint")}
            aria-describedby={`${id}-status`}
            autoComplete="off"
            className="min-w-0 flex-1 border-0 bg-transparent text-text-14 text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </label>
      </form>
      <p id={`${id}-status`} role="status" className="sr-only">
        {current ? t("gatewaySearch.home.count", { count }) : ""}
      </p>
      {text.length >= 2 ? (
        <nav
          aria-label={t("gatewaySearch.home.results")}
          className="flex flex-col gap-12 rounded-card border border-border-subtle bg-bg-surface p-12"
        >
          {groups.map((g) => (
            <section key={g.id} aria-labelledby={`${id}-${g.id}`} className="flex flex-col gap-4">
              <h2 id={`${id}-${g.id}`} className="m-0 text-text-12 font-medium text-text-secondary">
                {g.label}
              </h2>
              <ul className="m-0 flex list-none flex-col p-0">
                {g.items.map((item) => (
                  <li key={item.href + item.label}>
                    <NextLink
                      href={item.href as Route}
                      className="flex min-h-touch-min items-center gap-8 rounded-control px-4 text-text-14 text-text-primary no-underline hover:bg-bg-hover"
                    >
                      <span className="text-text-secondary">
                        <Icon name={item.icon} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    </NextLink>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <NextLink
            href={explore}
            className="flex min-h-touch-min items-center gap-8 rounded-control px-4 text-text-14 text-accent-text no-underline hover:bg-bg-hover"
          >
            <Icon name="Compass" />
            <span className="min-w-0 flex-1 truncate">
              {t("gatewaySearch.home.explore", { query: text })}
            </span>
          </NextLink>
        </nav>
      ) : null}
    </div>
  );
}
