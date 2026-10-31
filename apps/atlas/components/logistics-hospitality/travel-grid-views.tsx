"use client";

import type { MenuItem } from "@xos/ui";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { builtInViewEntries } from "@/lib/assets/built-in-views";
import type { FilterPreset } from "@/lib/views/query";
import { CollectionViews } from "@/components/views/collection-views";

/**
 * The flight grid's view switcher (B5, G-58): table and list, the person's saved views, and the built-in views
 * Upcoming, In Flight and All heading the menu, each of which a person may save as a copy (R7a). CollectionViews
 * carries the export, so CSV, .xlsx and PDF follow the phase filter on screen.
 */
export function TravelGridViews({
  label,
  view,
  options,
  presets,
}: {
  label: string;
  view: string;
  options: readonly { value: string; label: string }[];
  presets: readonly FilterPreset[];
}) {
  const tViews = useTranslations("views");
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const entries = builtInViewEntries(
    presets,
    new URLSearchParams(search.toString()),
    view,
    options.map((o) => o.value),
  );
  const items: MenuItem[] = [
    { heading: tViews("menu.builtIn") },
    ...entries.map((e) => ({
      label: e.preset.name,
      icon: "Filter" as const,
      active: e.active,
      onSelect: () => router.replace(`${pathname}?${e.query}` as Route, { scroll: false }),
    })),
  ];
  const current = entries.find((e) => e.active)?.preset.name;
  return (
    <CollectionViews
      label={label}
      value={view}
      options={[...options]}
      onChange={(next) => {
        const params = new URLSearchParams(search.toString());
        params.set("view", next);
        router.replace(`${pathname}?${params.toString()}` as Route, { scroll: false });
      }}
      leading={{ items, ...(current ? { current } : {}) }}
    />
  );
}
