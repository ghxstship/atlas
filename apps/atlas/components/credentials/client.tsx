"use client";

import { AccessGridMatrix, CredentialBadge, InlineAlert } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setMatrixCellAction } from "@/lib/credentials/actions";
import { useErrorCopy } from "@/components/operations/action-form";

export { CredentialBadge };

/**
 * The access matrix (Section 11.15, Matrix view) editing the grid in place: toggling a cell grants
 * the category entry to the zone at the default level for the default window, or withdraws every
 * grant of that pair. Levels and windows are edited in the Spreadsheet view. A person without
 * credentials.access_grid.write sees the matrix read-only.
 */
export function AccessMatrixEditor({
  org,
  projectId,
  label,
  zones,
  categories,
  grants,
  editable,
  accessLevelId,
  windowStartsAt,
  windowEndsAt,
}: {
  org: string;
  projectId: string;
  label: string;
  zones: readonly { id: string; label: string }[];
  categories: readonly { id: string; label: string }[];
  grants: readonly string[];
  editable: boolean;
  accessLevelId: string;
  windowStartsAt: string;
  windowEndsAt: string;
}) {
  const router = useRouter();
  const errors = useErrorCopy();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [version, setVersion] = useState(0);

  const onChange = (next: string[]) => {
    const before = new Set(grants);
    const after = new Set(next);
    const changed =
      [...after].find((g) => !before.has(g)) ?? [...before].find((g) => !after.has(g));
    if (!changed) return;
    const [catLabel, zoneLabel] = changed.split("|");
    const category = categories.find((c) => c.label === catLabel);
    const zone = zones.find((z) => z.label === zoneLabel);
    if (!category || !zone) return;
    start(async () => {
      const result = await setMatrixCellAction({
        org,
        projectId,
        categoryId: category.id,
        zoneId: zone.id,
        granted: after.has(changed),
        accessLevelId,
        windowStartsAt,
        windowEndsAt,
      });
      if (result.error) {
        setError(result.error);
        setVersion((v) => v + 1);
      } else {
        setError(null);
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-col gap-8" aria-busy={pending || undefined}>
      {error ? <InlineAlert tone="danger">{errors(error)}</InlineAlert> : null}
      <AccessGridMatrix
        key={`${version}-${grants.join(",")}`}
        label={label}
        zones={zones.map((z) => z.label)}
        categories={categories.map((c, i) => ({ name: c.label, color: (i % 7) + 1 }))}
        grants={[...grants]}
        {...(editable ? { onChange } : {})}
      />
    </div>
  );
}
