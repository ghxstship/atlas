"use client";

import { parseArchived } from "@xos/data/archive";
import { Select } from "@xos/ui";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * The Archived filter (A124, Section 4.10): archived rows are left out of a collection until the
 * person asks for them with `?archived=include` (every row) or `?archived=only` (the archived ones).
 * The page reads the same query parameter for its loader (packages/data/src/archive.ts), so every
 * view, an export and a shared link show the same rows. Each archivable collection renders it once
 * among its filters.
 */
export function ArchivedFilter({ id = "archived-filter" }: { id?: string }) {
  const t = useTranslations("archive.filter");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const value = parseArchived(params.get("archived"));
  return (
    <Select
      key={`archived-${value}`}
      id={id}
      label={t("label")}
      value={value === "exclude" ? "" : value}
      options={[
        { value: "", label: t("exclude") },
        { value: "include", label: t("include") },
        { value: "only", label: t("only") },
      ]}
      onChange={(e) => {
        const next = new URLSearchParams(params.toString());
        if (e.target.value === "") next.delete("archived");
        else next.set("archived", e.target.value);
        // An open peek may name a row the new filter leaves out.
        next.delete("peek");
        const qs = next.toString();
        router.replace((qs ? `${pathname}?${qs}` : pathname) as Route, { scroll: false });
      }}
    />
  );
}
