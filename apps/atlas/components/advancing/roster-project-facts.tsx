"use client";

import { offeredFactKinds, type RosterProjectFacts } from "@xos/data/roster-facts";
import { projectFactRows } from "@xos/data/roster-facts-display";
import { InlineAlert, PropertyList, Skeleton } from "@xos/ui";
import { useEffect, useState } from "react";
import { RefusalNotice } from "@/components/refusal-notice";
import { rosterProjectFactsAction } from "./roster-actions";
import { useCopy } from "./use-copy";

/** The capability each kind's read needs on the project (2655, private.project_fact_kind_capabilities). */
const CAPABILITY = {
  Travel: "hospitality.fulfillment.read",
  Uniform: "opportunities.engagement.read",
  Vehicle: "credentials.credential.read",
} as const;

const KEY = { Travel: "travel", Uniform: "uniform", Vehicle: "vehicle" } as const;

/**
 * A rostered person's project facts in the Crew review peek (R5, owner decision 4), read once when the peek opens
 * through app.roster_project_facts, which logs the read in the person's access log and the org's audit log. Each kind
 * the reader's capabilities open shows with who entered it; a kind they cannot read shows a refusal naming the
 * capability, never an empty value.
 */
export function RosterProjectFactsPeek({
  org,
  id,
  party,
}: {
  org: string;
  id: string;
  party: string;
}) {
  const wd = useCopy("workDetails");
  const errors = useCopy("advancing.errors");
  const [facts, setFacts] = useState<RosterProjectFacts | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void rosterProjectFactsAction(org, id).then((r) => {
      if (!live) return;
      if (r.ok) setFacts(r.facts);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [org, id]);
  if (error) return <InlineAlert tone="danger">{errors(error)}</InlineAlert>;
  if (!facts) return <Skeleton width="100%" height={96} />;
  const kinds = offeredFactKinds(facts.offered);
  return (
    <section aria-label={wd("projectFacts.title")} className="flex flex-col gap-8">
      <h3 className="m-0 text-label-13 font-semibold">{wd("projectFacts.title")}</h3>
      {kinds.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{wd("projectFacts.none")}</p>
      ) : (
        kinds.map((kind) => {
          const key = KEY[kind];
          const title = wd(`projectFacts.kinds.${key}`);
          if (!facts.readable.includes(kind)) {
            return (
              <RefusalNotice
                key={kind}
                outcome="REFUSE"
                title={title}
                reason={wd("projectFacts.notReadable", {
                  kind: wd(`projectFacts.kindsLower.${key}`),
                  capability: CAPABILITY[kind],
                })}
              />
            );
          }
          const rows = projectFactRows(wd, kind, facts);
          return (
            <div key={kind} className="flex flex-col gap-4">
              <h4 className="m-0 text-label-13 font-semibold">{title}</h4>
              {facts.present[key] ? (
                <>
                  <p className="m-0 text-text-12 text-text-secondary">
                    {facts.enteredByPerson[key]
                      ? wd("projectFacts.byPerson")
                      : wd("projectFacts.byCompany", { company: party })}
                  </p>
                  <PropertyList items={rows.map(([label, value]) => ({ label, value }))} />
                </>
              ) : (
                <p className="m-0 text-text-13 text-text-secondary">
                  {wd("projectFacts.notEntered")}
                </p>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}
