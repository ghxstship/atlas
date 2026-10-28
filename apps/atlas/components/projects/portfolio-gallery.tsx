"use client";

import type { ProjectSummary } from "@xos/data/projects";
import { Button, Card, Gallery, PhaseChip, StateChip } from "@xos/ui";
import { useTranslations } from "next-intl";
import { phaseCode, stateIcon } from "@/lib/projects/format";

/** Projects as cards (Gallery view). It loads when the Gallery view is shown, not with the list (A24-009). */
export function PortfolioGallery({
  projects,
  gateOf,
  dates,
  onOpen,
}: {
  projects: readonly ProjectSummary[];
  /** The gate of a phase code. */
  gateOf: (code: string) => number;
  /** A project's dates as the list shows them. */
  dates: (p: ProjectSummary) => string;
  /** Opens a project's peek by key. */
  onOpen: (key: string) => void;
}) {
  const t = useTranslations("projects");
  return (
    <Gallery label={t("list.galleryLabel")}>
      {projects.map((p) => (
        <Card
          key={p.id}
          interactive
          title={`${p.key} ${p.name}`}
          meta={
            <StateChip state={stateIcon(p.projectState)} label={t(`states.${p.projectState}`)} />
          }
          footer={
            <Button size="sm" variant="ghost" onClick={() => onOpen(p.key)}>
              {t("list.open")}
            </Button>
          }
        >
          <div className="flex flex-col gap-6 text-text-13 text-text-secondary">
            <PhaseChip
              gate={gateOf(p.phaseCode)}
              code={phaseCode(p.phaseCode)}
              name={t(`phases.${phaseCode(p.phaseCode)}`)}
            />
            <span>{p.venueName ?? p.jurisdictionId ?? t("values.unresolved")}</span>
            <span>{dates(p)}</span>
          </div>
        </Card>
      ))}
    </Gallery>
  );
}
