"use client";

import type { ProjectSummary } from "@xos/data/projects";
import { Button, Drawer, PhaseChip, PropertyList, StateChip, type PhaseCode } from "@xos/ui";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { CustomFieldsSection } from "@/components/custom-fields/custom-fields-section";
import { phaseCode, stateIcon } from "@/lib/projects/format";

/**
 * A project's side peek on the Projects collection (project-collection.tsx): its state, phase and settings, and
 * its custom fields (A117). It loads when a peek first opens, not with the list (A24-009).
 */
export function ProjectPeek({
  org,
  peek,
  gate,
  dates,
  onClose,
}: {
  org: string;
  peek: ProjectSummary;
  /** The gate of the project's phase. */
  gate: number;
  /** The project's dates as the list shows them. */
  dates: string;
  onClose: () => void;
}) {
  const t = useTranslations("projects");
  const router = useRouter();
  const href = (tab: string) => `/${org}/p/${peek.key}/${tab}` as Route;
  return (
    <Drawer
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t("peek.title", { key: peek.key, name: peek.name })}
      footer={
        <>
          <Button onClick={() => router.push(href("gates"))}>{t("peek.gates")}</Button>
          <Button variant="primary" onClick={() => router.push(href("overview"))}>
            {t("peek.openProject")}
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap gap-6">
        <StateChip state={stateIcon(peek.projectState)} label={t(`states.${peek.projectState}`)} />
        <PhaseChip
          gate={gate}
          code={phaseCode(peek.phaseCode) as PhaseCode}
          name={t(`phases.${phaseCode(peek.phaseCode)}`)}
        />
      </div>
      <PropertyList
        items={[
          { label: t("fields.production"), value: t(`states.${peek.productionState}`) },
          { label: t("fields.jurisdiction"), value: peek.jurisdictionId ?? t("values.unresolved") },
          { label: t("fields.venue"), value: peek.venueName ?? t("values.none") },
          { label: t("fields.region"), value: peek.regionCode ?? t("values.none") },
          { label: t("fields.currency"), value: peek.currency },
          { label: t("fields.timeZone"), value: peek.timeZone },
          { label: t("fields.dates"), value: dates },
        ]}
      />
      <CustomFieldsSection table="app.projects" id={peek.id} />
    </Drawer>
  );
}
