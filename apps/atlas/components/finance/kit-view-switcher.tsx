"use client";

import { CollectionViews } from "@/components/views/collection-views";
import { useFinanceT } from "./kit-use-finance-t";
import { useQueryNav } from "./kit-use-query-nav";

// View switcher and filters ------------------------------------------------------------------------

export function ViewSwitcher({ views, value }: { views: readonly string[]; value: string }) {
  const t = useFinanceT();
  const go = useQueryNav();
  if (views.length < 2) return null;
  return (
    <CollectionViews
      label={t("common.viewLabel")}
      value={value}
      options={views.map((v) => ({ value: v, label: t(`views.${v}`) }))}
      onChange={(v) => go({ view: v }, true)}
    />
  );
}
