import { type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { chipClass, codeClass } from "../Chips/Chips.tsx";
import { type ProvenanceBadgeProps } from "./XOS.types.ts";

/** Who wrote a canon field and its provenance rank. */
export function ProvenanceBadge({ source, rank }: ProvenanceBadgeProps): ReactElement {
  const t = useT();
  return (
    <span className={chipClass} title={t("provenance.rank", { rank })}>
      <span className="text-text-secondary">{t("provenance.source")}</span>
      <span>{source}</span>
      <span className={codeClass}>
        <span className="sr-only">{t("provenance.rank", { rank })}</span>
        <span aria-hidden="true">{rank}</span>
      </span>
    </span>
  );
}
