import { getTranslations } from "next-intl/server";
import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import type { PageScope } from "./kit";
import { PageHeader, RefusalNotice, TemplateCollection } from "./ui";

/** The rooming list's client loads on the Rooming section only (B5); it reads on request, as each read is logged. */
const RoomingList = dynamic(() => import("./rooming").then((m) => m.RoomingList));

/**
 * The project Hospitality tab's Rooming section (B5, G-67): the rooming list of the project, for holders of
 * hospitality.fulfillment.read. No export: it reads project facts (R5).
 */
export async function RoomingSection({
  scope,
  heading,
}: {
  scope: PageScope;
  heading?: ReactNode;
}) {
  const t = await getTranslations("hospitality.rooming");
  const tc = await getTranslations("logistics.common");
  const project = scope.project;
  const readable = project ? scope.access.can(project.id, "hospitality.fulfillment.read") : false;
  return (
    <TemplateCollection
      header={
        <>
          {heading}
          <PageHeader title={t("title")} />
        </>
      }
    >
      {project && readable ? (
        <RoomingList org={scope.ctx.org.slug} projectId={project.id} />
      ) : (
        <RefusalNotice outcome="REFUSE" title={tc("refusal.createTitle")} reason={t("needsRead")} />
      )}
    </TemplateCollection>
  );
}
