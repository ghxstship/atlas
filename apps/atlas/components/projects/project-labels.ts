"use client";

import type { ProjectSummary } from "@xos/data/projects";
import { useFormatter, useTranslations } from "next-intl";
import { phaseCode } from "@/lib/projects/format";

export interface PhaseInfo {
  readonly code: string;
  readonly gate: number;
}

/**
 * How the Projects collection names a project's gate, phase, state and dates, shared by the table
 * the page loads with and the views and peek that load when shown.
 */
export function useProjectLabels(phases: readonly PhaseInfo[]) {
  const t = useTranslations("projects");
  const format = useFormatter();
  const date = (iso: string | null) =>
    iso === null ? null : format.dateTime(new Date(`${iso}T00:00:00`), { dateStyle: "medium" });
  return {
    gateOf: (code: string) => phases.find((p) => p.code === code)?.gate ?? 0,
    phaseName: (code: string) => t(`phases.${phaseCode(code)}`),
    stateLabel: (p: ProjectSummary) => t(`states.${p.projectState}`),
    dates: (p: ProjectSummary) => {
      const s = date(p.startsOn);
      const e = date(p.endsOn);
      if (s && e) return t("values.dateRange", { start: s, end: e });
      if (s) return t("values.from", { start: s });
      if (e) return t("values.until", { end: e });
      return t("values.noDates");
    },
  };
}
