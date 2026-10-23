"use client";

import { Input, Select } from "@xos/ui";
import { useState } from "react";
import { AskFilterEntry } from "@/components/aurora/entry/ask-entry";
import type { AskCatalog } from "@/lib/aurora/ask";
import { useFinanceT } from "./kit-use-finance-t";
import { useQueryNav } from "./kit-use-query-nav";
import { type Option } from "./kit.types";

/**
 * Project, state and text filters. Each change rewrites the query string, so the filters survive a
 * view switch and a reload (Section 11.15).
 */
export function FilterBar({
  projects,
  project,
  states,
  state,
  q,
  showSearch = true,
  ask,
}: {
  projects?: readonly Option[] | undefined;
  project?: string | null;
  states?: readonly Option[] | undefined;
  state?: string | null;
  q?: string | null;
  showSearch?: boolean;
  /** The page's filters for Ask in plain language (A95); the field shows only while it is on. */
  ask?: AskCatalog | undefined;
}) {
  // A new search from the URL (an applied plain-language filter) shows in the search field.
  const bar = (
    <Filters
      key={`q-${q ?? ""}`}
      projects={projects}
      project={project}
      states={states}
      state={state}
      q={q}
      showSearch={showSearch}
    />
  );
  if (!ask) return bar;
  return (
    <div className="flex flex-col gap-12">
      {bar}
      <AskFilterEntry catalog={ask} />
    </div>
  );
}

function Filters({
  projects,
  project,
  states,
  state,
  q,
  showSearch,
}: {
  projects?: readonly Option[] | undefined;
  project?: string | null | undefined;
  states?: readonly Option[] | undefined;
  state?: string | null | undefined;
  q?: string | null | undefined;
  showSearch: boolean;
}) {
  const t = useFinanceT();
  const go = useQueryNav();
  const [text, setText] = useState(q ?? "");
  return (
    <form
      role="search"
      aria-label={t("common.filters")}
      className="flex flex-wrap items-end gap-12"
      onSubmit={(e) => {
        e.preventDefault();
        go({ q: text.trim() === "" ? null : text.trim(), peek: null }, true);
      }}
    >
      {projects ? (
        <Select
          key={`project-${project ?? ""}`}
          id="filter-project"
          label={t("common.project")}
          value={project ?? ""}
          options={[{ value: "", label: t("common.allProjects") }, ...projects]}
          onChange={(e) => go({ project: e.target.value || null, peek: null }, true)}
        />
      ) : null}
      {states ? (
        <Select
          key={`state-${state ?? ""}`}
          id="filter-state"
          label={t("common.state")}
          value={state ?? ""}
          options={[{ value: "", label: t("common.allStates") }, ...states]}
          onChange={(e) => go({ state: e.target.value || null, peek: null }, true)}
        />
      ) : null}
      {showSearch ? (
        <Input
          id="filter-search"
          type="search"
          label={t("common.search")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => go({ q: text.trim() === "" ? null : text.trim(), peek: null }, true)}
        />
      ) : null}
    </form>
  );
}
