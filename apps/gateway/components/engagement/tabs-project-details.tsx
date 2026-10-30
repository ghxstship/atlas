import { getRosterProjectFacts } from "@xos/data/roster-facts";
import { listEngagementRoster } from "@xos/data/roster";
import { RegionError, Section } from "@/components/page/page";
import { InlineAlert } from "@/components/ui";
import { ProjectFactsWizard } from "@/components/roster/project-facts-wizard";
import type { TabProps } from "./tab-context";

/**
 * The Project details tab (R5, ADR 0100 and 0102): the person enters the travel, uniform sizes and vehicle the project
 * asks of them, on their own roster entry of this engagement. The tab shows only when travel, uniforms or parking is
 * offered (offered-project-facts). Nothing is written to the profile, and the person's own reads are not logged.
 */
export async function ProjectDetailsTab({ view, t }: TabProps) {
  const roster = await listEngagementRoster(view.ctx.db, view.engagement.id);
  if (!roster.ok) return <RegionError />;
  const mine = roster.data.filter(
    (e) =>
      e.personId === view.ctx.personId &&
      e.entryState !== "Withdrawn" &&
      e.personResponse !== "Declined",
  );
  const facts = await Promise.all(mine.map((e) => getRosterProjectFacts(view.ctx.db, e.id)));
  if (facts.some((f) => !f.ok)) return <RegionError />;
  const loaded = facts.flatMap((f) => (f.ok ? [f.data] : []));
  const asked = loaded.filter((f) => f.offered.travel || f.offered.uniforms || f.offered.parking);
  return (
    <div className="flex flex-col gap-16">
      <p className="m-0 max-w-[60ch] text-text-14 text-text-secondary">
        {t("workDetails.projectFacts.sentence")}
      </p>
      {asked.length === 0 ? (
        <InlineAlert tone="info">{t("workDetails.projectFacts.none")}</InlineAlert>
      ) : (
        asked.map((f) => (
          <Section key={f.rosterEntryId} title={t("workDetails.projectFacts.title")}>
            <ProjectFactsWizard
              facts={f}
              mode="person"
              personName=""
              projectName={view.engagement.projectName}
            />
          </Section>
        ))
      )}
    </div>
  );
}
