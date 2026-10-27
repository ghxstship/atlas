"use client";

import type { MenuItem } from "@xos/ui";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { DeferredDropdownMenu } from "@/components/shell/deferred-menus";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import { collectionKeyFor } from "@/lib/views/query";
import type { ExportAsk, Format } from "./collection-export-runner";

/** The export's requests, polling, step-up and toast load when someone first picks a format (A24-009). */
const runner = onDemand(() => import("./collection-export-runner"));

/** Copy lookups take built keys (`export.formats.csv`), so the catalog type is widened. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

const FORMATS: readonly { readonly format: Format; readonly key: string; readonly icon: string }[] =
  [
    { format: "CSV", key: "csv", icon: "FileText" },
    { format: "XLSX", key: "xlsx", icon: "FileSpreadsheet" },
    { format: "PDF", key: "pdf", icon: "File" },
  ];

/**
 * Export of the collection on screen (Section 4.6.4), beside the saved views of every collection: CSV,
 * .xlsx or PDF of the current view, with its filters and search. The database classifies the columns
 * (Section 8.6); a Restricted column asks for step-up first, then the export goes ahead. The file is
 * written by the export.render worker, so ExportRunner follows the export in a toast and downloads it
 * when it is ready. The wrapper carries data-shortcut="view.export" for the keyboard shortcut.
 */
export function CollectionExport() {
  const t = useTranslations("views") as unknown as Translate;
  const pathname = usePathname();
  const org = pathname.split("/").filter(Boolean)[0] ?? "";
  const collection = collectionKeyFor(pathname);
  const [ask, setAsk] = useState<ExportAsk | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = useOnDemand(runner, ask !== null);

  if (!collection || !org) return null;

  const items: MenuItem[] = [
    { heading: t("export.heading") },
    ...FORMATS.map((f) => ({
      label: t(`export.formats.${f.key}`),
      icon: f.icon,
      disabled: busy,
      onSelect: () => setAsk({ format: f.format, at: Date.now() }),
    })),
  ];

  return (
    <span data-shortcut="view.export" className="contents">
      <DeferredDropdownMenu label={t("export.label")} icon="Download" items={items} />
      {loaded && ask ? (
        <loaded.ExportRunner org={org} pathname={pathname} ask={ask} onBusy={setBusy} />
      ) : null}
    </span>
  );
}
