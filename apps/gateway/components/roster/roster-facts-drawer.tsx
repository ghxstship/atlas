"use client";

import { offeredFactKinds, type RosterProjectFacts } from "@xos/data/roster-facts";
import { Button, Drawer, InlineAlert, Skeleton } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { viewRosterFactsAction } from "@/lib/actions/roster-facts";
import { byKind } from "@/lib/roster-facts-steps";
import { FactSummary } from "./project-facts-summary";
import { ProjectFactsWizard } from "./project-facts-wizard";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Project details of one crew member for their roster manager (R5, owner decision 4): read once when the drawer opens,
 * through app.roster_project_facts, which logs the read in the person's access log. Each kind shows who entered it.
 * For a kind the person has not entered, the manager may enter it for them ('Enter for {name}'); the producing org
 * decides whether that is allowed, and the RPC refuses otherwise. Opened by the person themselves (Gateway Home's
 * roster row and updates, `self`), it is titled Project details and holds their own wizard; their read is not logged.
 */
export function RosterFactsDrawer({
  rosterEntryId,
  name,
  companyName,
  projectName,
  self = false,
  onClose,
}: {
  rosterEntryId: string;
  name: string;
  companyName: string;
  projectName: string;
  self?: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("workDetails") as unknown as Translate;
  const [facts, setFacts] = useState<RosterProjectFacts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let live = true;
    void viewRosterFactsAction(rosterEntryId).then((r) => {
      if (!live) return;
      if (r.ok) setFacts(r.facts);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [rosterEntryId, reads]);
  const kinds = facts ? offeredFactKinds(facts.offered) : [];
  const own = facts?.standing === "Person";
  const canEnter =
    facts?.standing === "Company" && kinds.some((k) => !facts.enteredByPerson[byKind(k)]);
  return (
    <Drawer
      open
      title={
        self ? t("projectFacts.title") : t("projectFacts.drawerTitle", { name })
      }
      onClose={onClose}
    >
      {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
      {!facts && !error ? <Skeleton height={96} /> : null}
      {facts && own ? (
        kinds.length === 0 ? (
          <p className="m-0 text-text-14 text-text-secondary">{t("projectFacts.none")}</p>
        ) : (
          <ProjectFactsWizard
            facts={facts}
            mode="person"
            personName={name}
            projectName={projectName}
            onDone={onClose}
            onSaved={() => setReads((n) => n + 1)}
          />
        )
      ) : null}
      {facts && !own && entering ? (
        <ProjectFactsWizard
          facts={facts}
          mode="company"
          personName={name}
          projectName={projectName}
          onSaved={() => setReads((n) => n + 1)}
          onDone={() => {
            setEntering(false);
            setReads((n) => n + 1);
          }}
        />
      ) : null}
      {facts && !own && !entering ? (
        <div className="flex flex-col gap-16">
          {kinds.length === 0 ? (
            <p className="m-0 text-text-14 text-text-secondary">{t("projectFacts.none")}</p>
          ) : (
            kinds.map((kind) => {
              const key = byKind(kind);
              return (
                <section key={kind} className="flex flex-col gap-8">
                  <h3 className="m-0 text-heading-16 font-semibold">
                    {t(`projectFacts.kinds.${key}`)}
                  </h3>
                  {facts.present[key] ? (
                    <p className="m-0 text-text-13 text-text-secondary">
                      {facts.enteredByPerson[key]
                        ? t("projectFacts.enteredBy", { name })
                        : t("projectFacts.enteredBy", { name: companyName })}
                    </p>
                  ) : null}
                  <FactSummary t={t} kind={kind} facts={facts} />
                </section>
              );
            })
          )}
          {canEnter ? (
            <div>
              <Button type="button" variant="primary" size="sm" onClick={() => setEntering(true)}>
                {t("projectFacts.enterFor", { name })}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
