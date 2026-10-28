"use client";

import type { ProjectSummary } from "@xos/data/projects";
import { Board, type RecordState } from "@xos/ui";
import { useTranslations } from "next-intl";
import { phaseCode, PROJECT_STATE_ORDER, stateIcon } from "@/lib/projects/format";
import type { BoardMode, PhaseInfo } from "./project-collection";

/**
 * Projects in columns by state, or by phase (Board view, and the gate board of Projects > By phase). It loads
 * when the Board view is shown, not with the list (A24-009).
 */
export function PortfolioBoard({
  projects,
  phases,
  mode,
  onOpen,
}: {
  projects: readonly ProjectSummary[];
  phases: readonly PhaseInfo[];
  mode: BoardMode;
  /** Opens a project's peek by key. */
  onOpen: (key: string) => void;
}) {
  const t = useTranslations("projects");
  const phaseName = (code: string) => t(`phases.${phaseCode(code)}`);
  const columns =
    mode === "phase"
      ? phases.map((ph) => ({
          state: "active" as RecordState,
          label: t("gates.gate", { gate: ph.gate }) + ` · ${phaseName(ph.code)}`,
          cards: projects
            .filter((p) => p.phaseCode === ph.code)
            .map((p) => ({
              key: p.key,
              title: p.name,
              meta: `${p.key} · ${t(`states.${p.projectState}`)}`,
            })),
        }))
      : PROJECT_STATE_ORDER.map((s) => ({
          state: stateIcon(s),
          label: t(`states.${s}`),
          cards: projects
            .filter((p) => p.projectState === s)
            .map((p) => ({
              key: p.key,
              title: p.name,
              meta: `${p.key} · ${phaseName(p.phaseCode)}`,
            })),
        }));
  return (
    <section aria-label={mode === "phase" ? t("list.phaseBoardLabel") : t("list.boardLabel")}>
      <Board readOnly columns={columns} onOpen={onOpen} />
    </section>
  );
}
