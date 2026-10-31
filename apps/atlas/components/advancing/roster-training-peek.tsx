import { listRosterTrainingRecords } from "@xos/data/crew";
import type { XosClient } from "@xos/data";
import { verifyRosterTrainingAction } from "@/app/[org]/crew/actions";
import { ConfirmButton } from "@/components/crew/forms-confirm-button";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Training on an agency staff member's roster entry (R12, journey 42), in the Advancing > Crew peek: what they
 * acknowledged, and Record verification for a requirement the production reviews. The database refuses the person
 * themself (sod_roster_training) and anyone without opportunities.onboarding.write on the project.
 */
export async function RosterTrainingPeek({
  db,
  org,
  id,
}: {
  db: XosClient;
  org: string;
  id: string;
}) {
  const t = await getTranslate();
  const records = await listRosterTrainingRecords(db, id);
  if (!records.ok) throw new Error(`Cannot read the roster training: ${records.error.kind}`);
  return (
    <section aria-label={t("crew.agency.trainingTitle")} className="flex flex-col gap-8">
      <h3 className="m-0 text-label-13 font-semibold">{t("crew.agency.trainingTitle")}</h3>
      {records.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("crew.agency.trainingEmpty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-8 p-0">
          {records.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-8">
              <span className="text-text-13">
                {r.requirementName ?? ""}
                <span className="text-text-secondary">
                  {" · "}
                  {r.outcome === "Passed"
                    ? t("crew.agency.passed")
                    : r.outcome === "Failed"
                      ? t("crew.agency.failed")
                      : t("crew.agency.awaiting")}
                </span>
              </span>
              {r.verificationMethod === "Reviewer" && r.outcome === null ? (
                <span className="flex gap-8">
                  <ConfirmButton
                    label={t("crew.agency.recordVerification")}
                    title={t("crew.agency.recordVerification")}
                    defaultReason={t("crew.agency.passed")}
                    action={verifyRosterTrainingAction}
                    hidden={{ org, recordId: r.id, outcome: "Passed" }}
                    reason={false}
                    confirmLabel={t("crew.agency.passed")}
                  />
                  <ConfirmButton
                    label={t("crew.agency.failed")}
                    title={t("crew.agency.recordVerification")}
                    defaultReason={t("crew.agency.failed")}
                    action={verifyRosterTrainingAction}
                    hidden={{ org, recordId: r.id, outcome: "Failed" }}
                    reason={false}
                    variant="ghost"
                  />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
