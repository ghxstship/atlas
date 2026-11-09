"use client";

import { summarizeProjectCopy } from "@xos/data/project-copy";
import { Tag } from "@xos/ui";
import { useTranslations } from "next-intl";
import type { CopyPreviewState } from "@/lib/projects/intake";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** A copy's preview grouped by part, with each skip's reason in words. Shared with the Settings copy dialog. */
export function CopyPreviewList({ preview }: { preview: CopyPreviewState }) {
  const t = useTranslations("projects") as unknown as Translate;
  if (!preview.ok) {
    return (
      <p className="m-0 text-text-13 text-danger" role="alert">
        {t(`errors.${preview.error}`)}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-12" aria-live="polite">
      {summarizeProjectCopy(preview.items).map((p) => (
        <section key={p.part} className="flex flex-col gap-4">
          <h4 className="m-0 text-text-13 font-semibold">
            {t("copy.partSummary", {
              part: t(`copy.partNames.${p.part.replaceAll(" ", "")}`),
              copied: p.copied,
              skipped: p.skipped,
            })}
          </h4>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-text-12">
            {preview.items
              .filter((i) => i.part === p.part)
              .map((i) => (
                <li
                  key={`${i.itemKind}:${i.sourceId}`}
                  className="flex flex-wrap items-center gap-6"
                >
                  <Tag tone={i.outcome === "copy" ? "success" : "neutral"}>
                    {t(i.outcome === "copy" ? "copy.copied" : "copy.skipped")}
                  </Tag>
                  <span>{i.label}</span>
                  {i.skipReason ? (
                    <span className="text-text-secondary">{t(`copy.reasons.${i.skipReason}`)}</span>
                  ) : null}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
