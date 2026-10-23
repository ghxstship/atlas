import { listOpenScanIntake } from "@xos/data/scan-intake";
import { getFormatter } from "next-intl/server";
import { BindingEntry } from "@/components/aurora/entry/binding-entry";
import { dateTime } from "@/components/operations/chrome";
import { ActionForm } from "@/components/operations/action-form";
import { TextField } from "@/components/operations/fields";
import { RecordSection } from "@/components/operations/kit";
import { dismissScanIntakeAction } from "@/lib/credentials/actions";
import { can, type ModulePage } from "@/lib/operations/context";

/**
 * The scan intake queue on the scan log (Section 13, migration 0367; A95): codes Compass could not
 * resolve on the spot, newest first, until someone resolves each once. With mapping help on, Suggest
 * binding asks Aurora which catalog element the code identifies and binds it after the person
 * confirms; any code can be dismissed with a note. Nothing is ever mapped automatically.
 */
export async function ScanIntakeQueue({ page }: { page: ModulePage }) {
  const t = page.t;
  const format = await getFormatter();
  const result = await listOpenScanIntake(page.ctx.viewer.db, {
    orgId: page.ctx.org.id,
    projectId: page.project?.id ?? null,
  });
  const canResolve = can(page, "credentials.scan.write");
  const canBind = canResolve && page.ctx.capabilities.has("procurement.catalog.write");
  return (
    <RecordSection id="scan-intake" title={t("credentials.intake.heading")}>
      <p className="m-0 text-text-13 text-text-secondary">{t("credentials.intake.help")}</p>
      {!result.ok ? (
        <p role="alert" className="m-0 text-text-13 text-danger-text">
          {t("credentials.intake.loadError")}
        </p>
      ) : result.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("credentials.intake.empty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
          {result.data.map((scan) => (
            <li key={scan.id} className="flex flex-col gap-8 p-12">
              <div className="flex flex-wrap items-start justify-between gap-8">
                <div className="flex min-w-0 flex-col gap-2">
                  <span className="break-all font-mono text-text-13 font-medium">
                    {scan.scannedValue}
                  </span>
                  <span className="text-text-12 text-text-secondary">
                    {t("credentials.intake.meta", {
                      symbology: scan.symbology,
                      mode: t(`credentials.intake.modes.${scan.scanMode}`),
                      project: scan.projectKey ?? "",
                      who: scan.scannedByName ?? t("credentials.common.unnamed"),
                      when: dateTime(
                        format,
                        scan.deviceScannedAt,
                        page.projects.find((p) => p.id === scan.projectId)?.timeZone,
                      ),
                    })}
                  </span>
                </div>
                {canBind ? (
                  <BindingEntry
                    org={page.ctx.org.slug}
                    scan={{
                      id: scan.id,
                      code: scan.scannedValue,
                      symbology: scan.symbology,
                      projectKey: scan.projectKey,
                    }}
                  />
                ) : null}
              </div>
              {canResolve ? (
                <details className="text-text-13">
                  <summary className="cursor-pointer text-accent-text">
                    {t("credentials.intake.dismiss")}
                  </summary>
                  <div className="mt-8">
                    <ActionForm
                      action={dismissScanIntakeAction}
                      hidden={{ org: page.ctx.org.slug, scanId: scan.id }}
                      submitLabel={t("credentials.intake.dismissSubmit")}
                      variant="secondary"
                      layout="inline"
                    >
                      <TextField
                        id={`dismiss-${scan.id}`}
                        name="note"
                        label={t("credentials.intake.note")}
                        help={t("credentials.intake.noteHelp")}
                        required
                        maxLength={1000}
                        wide
                      />
                    </ActionForm>
                  </div>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </RecordSection>
  );
}
