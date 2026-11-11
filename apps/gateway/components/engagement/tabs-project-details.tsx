import { getRosterProjectFacts, listRosterFactStatus } from "@xos/data/roster-facts";
import { listMySensitiveConsents, standingFor } from "@xos/data/sensitive-consent";
import { listEngagementRoster } from "@xos/data/roster";
import type { Route } from "next";
import Link from "next/link";
import { RegionError, Section } from "@/components/page/page";
import { InlineAlert, StateChip } from "@/components/ui";
import { ProjectFactsWizard } from "@/components/roster/project-facts-wizard";
import { tabHref } from "@/lib/engagement";
import { othersOwedFacts } from "@/lib/roster";
import { chipState } from "@/lib/roster-facts-steps";
import { RowList } from "./rows";
import type { TabProps } from "./tab-context";

/**
 * The Project details tab (R5, ADR 0100 and 0102): the person enters the travel, uniform sizes and vehicle the project
 * asks of them, on their own roster entry of this engagement. The tab shows only when travel, uniforms or parking is
 * offered (offered-project-facts). Nothing is written to the profile, and the person's own reads are not logged.
 *
 * Someone who manages the roster without being on it, such as an artist's representative, has nothing of their own to
 * enter: they read what each person on the roster still owes (app.roster_project_fact_status, presence only), rather than
 * being told the project asks for nothing (4.9 surface crawl).
 */
export async function ProjectDetailsTab({ view, t, engagementKey }: TabProps) {
  const [roster, statuses] = await Promise.all([
    listEngagementRoster(view.ctx.db, view.engagement.id),
    listRosterFactStatus(view.ctx.db, view.engagement.id),
  ]);
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
  // Presence only, and only for entries the viewer has standing on; a refusal leaves the section out.
  const owed = othersOwedFacts(roster.data, statuses.ok ? statuses.data : [], view.ctx.personId);
  const consents = await listMySensitiveConsents(view.ctx.db);
  const mealConsent = consents.ok && standingFor(consents.data, "Dietary and Allergies") !== null;
  return (
    <div className="flex flex-col gap-16">
      <p className="m-0 max-w-[60ch] text-text-14 text-text-secondary">
        {t("workDetails.projectFacts.sentence")}
      </p>
      {asked.length === 0 && owed.length === 0 ? (
        <InlineAlert tone="info">{t("workDetails.projectFacts.none")}</InlineAlert>
      ) : (
        asked.map((f) => (
          <Section key={f.rosterEntryId} title={t("workDetails.projectFacts.title")}>
            <ProjectFactsWizard
              facts={f}
              mode="person"
              personName=""
              projectName={view.engagement.projectName}
              mealConsent={mealConsent}
            />
          </Section>
        ))
      )}
      {owed.length > 0 ? (
        <Section
          id="crew-project-details"
          title={t("gateway.engagement.projectDetails.othersTitle")}
        >
          <div className="flex flex-col gap-12">
            <p className="m-0 max-w-[60ch] text-text-14 text-text-secondary">
              {t("gateway.engagement.projectDetails.othersSentence")}
            </p>
            <RowList
              label={t("gateway.engagement.projectDetails.othersTitle")}
              items={owed.map((o) => ({
                id: o.rosterEntryId,
                title: o.name ?? t("gateway.engagement.projectDetails.someone"),
                meta: [],
                action: (
                  <span className="flex flex-wrap items-center gap-8">
                    {o.kinds.map(({ kind, chip }) => (
                      <StateChip
                        key={kind}
                        compact
                        state={chipState(chip)}
                        label={`${t(`workDetails.projectFacts.kinds.${kind}`)}: ${t(`workDetails.projectFacts.chips.${chip}`)}`}
                      />
                    ))}
                  </span>
                ),
              }))}
            />
            {view.tabs.includes("engagement.crew") ? (
              <Link
                href={tabHref(engagementKey, "engagement.crew") as Route}
                className="text-text-13 text-accent-text underline"
              >
                {t("gateway.engagement.projectDetails.othersCrew")}
              </Link>
            ) : null}
          </div>
        </Section>
      ) : null}
    </div>
  );
}
