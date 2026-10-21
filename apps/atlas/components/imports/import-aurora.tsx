"use client";

import { createAuroraClient } from "@xos/ai/client";
import type { ImportColumn, ImportTargetField } from "@xos/data/imports";
import { Button, InlineAlert } from "@xos/ui";
import { useEffect, useMemo, useState } from "react";
import { usePlatformT } from "@/components/platform/kit";

/** A field Aurora suggested for a column; the wizard shows it as a choice the person still confirms. */
export interface AuroraChoice {
  readonly columnId: string;
  readonly field: string;
}

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | {
      readonly kind: "message";
      readonly tone: "info" | "success" | "danger";
      readonly text: string;
    };

/**
 * Aurora's step of the mapping (Section 4.6.2 step 3, Section 4.7; A83, finding A65-025): asks aurora.mapColumns
 * through the public API with the person's own session, so the AI seam checks the org's AI switch, plan and
 * allowance and logs the request. Only the column names and the target's fields are sent, never cell values.
 * Suggestions fill only columns the person has left unmapped; every mapping is still confirmed by the person.
 * Shown only when the org has the mapping feature on.
 */
export function ImportAuroraSuggest({
  targetCode,
  columns,
  fields,
  choice,
  onApply,
}: {
  targetCode: string;
  columns: readonly ImportColumn[];
  fields: readonly ImportTargetField[];
  choice: Readonly<Record<string, string>>;
  onApply: (picks: readonly AuroraChoice[]) => void;
}) {
  const t = usePlatformT();
  const client = useMemo(() => createAuroraClient({ baseUrl: "/api/v1" }), []);
  const [enabled, setEnabled] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    let live = true;
    void client.status().then((r) => {
      if (live) setEnabled(r.ok && r.data.enabled_features.includes("mapping"));
    });
    return () => {
      live = false;
    };
  }, [client]);

  if (!enabled) return null;

  const headerOf = (c: ImportColumn) =>
    c.header || t("imports.map.untitled", { index: c.index + 1 });
  const suggest = async () => {
    setPhase({ kind: "running" });
    const result = await client.mapColumns({
      collection: targetCode.replace(/_/g, "-"),
      columns: columns.map((c) => ({ header: headerOf(c), samples: [] })),
      fields: fields.map((f) => ({ name: f.name, description: t(`imports.fields.${f.name}`) })),
    });
    if (!result.ok) {
      setPhase({ kind: "message", tone: "danger", text: t("imports.aurora.failed") });
      return;
    }
    if (result.data.outcome === "no_answer") {
      setPhase({
        kind: "message",
        tone: "info",
        text: t("imports.aurora.noAnswer", { missing: result.data.missing ?? "" }),
      });
      return;
    }
    if (result.data.outcome !== "answer" || !result.data.answer) {
      setPhase({ kind: "message", tone: "danger", text: t("imports.aurora.failed") });
      return;
    }
    const taken = new Set(Object.values(choice).filter(Boolean));
    const picks: AuroraChoice[] = [];
    for (const mapping of result.data.answer) {
      const column = columns.find((c) => headerOf(c) === mapping.column);
      if (!column || mapping.field === null || choice[column.id] || taken.has(mapping.field))
        continue;
      taken.add(mapping.field);
      picks.push({ columnId: column.id, field: mapping.field });
    }
    if (picks.length === 0) {
      setPhase({ kind: "message", tone: "info", text: t("imports.aurora.none") });
      return;
    }
    onApply(picks);
    setPhase({
      kind: "message",
      tone: "success",
      text: t("imports.aurora.applied", { count: picks.length }),
    });
  };

  return (
    <div className="flex flex-col gap-8 rounded-card border border-border-subtle p-12">
      <div className="flex flex-wrap items-center gap-12">
        <Button
          variant="secondary"
          loading={phase.kind === "running"}
          onClick={() => void suggest()}
        >
          {t("imports.aurora.button")}
        </Button>
        <p className="m-0 text-text-12 text-text-secondary">{t("imports.aurora.note")}</p>
      </div>
      <div aria-live="polite">
        {phase.kind === "running" ? (
          <p className="m-0 text-text-12 text-text-secondary">{t("imports.aurora.running")}</p>
        ) : phase.kind === "message" ? (
          <InlineAlert tone={phase.tone}>{phase.text}</InlineAlert>
        ) : null}
      </div>
    </div>
  );
}
