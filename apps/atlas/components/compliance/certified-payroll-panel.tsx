import { todayIn, zoneOrUtc } from "@xos/data/calendar";
import {
  getCertifiedPayrollHeader,
  type CertifiedPayrollHeader,
} from "@xos/data/certified-payroll";
import { getTranslations } from "next-intl/server";
import { ActionForm } from "@/components/operations/action-form";
import { SelectField, TextField } from "@/components/operations/fields";
import { Button } from "@/components/ui";
import { saveCertifiedPayrollHeaderAction } from "@/lib/compliance/actions";
import { usComplianceFormsOn } from "@/lib/compliance/flag";
import { lastWeekEnding } from "@/lib/crew/time";
import type { OrgContext } from "@/lib/shell/context";
import { getOrgWeekStart } from "@/lib/shell/time-zone";

/**
 * Settings, Payroll and Time Off: the WH-347 certified payroll (Section 14.5; migration 1386, ADR
 * 0041). Each covered project keeps its header (contract and wage determination numbers, business
 * name and address, location); issuing a week numbers it and downloads the form as PDF or CSV. Pay
 * rates are Restricted: the database asks for the restricted export capability and step-up
 * authentication, and a refusal answers with its rule. Shown only while the org has the
 * compliance.us_forms flag on (ADR 0033 decision 54, migration 1593).
 */

type T = (key: string, values?: Record<string, string | number>) => string;

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly projectKey: string;
  readonly timeZone: string;
}

async function listProjects(ctx: OrgContext): Promise<ProjectRow[]> {
  const { data } = await (
    ctx.viewer.db as unknown as {
      from(t: string): {
        select(c: string): {
          eq(
            c: string,
            v: string,
          ): {
            is(
              c: string,
              v: null,
            ): {
              order(c: string): PromiseLike<{ data: Record<string, unknown>[] | null }>;
            };
          };
        };
      };
    }
  )
    .from("projects")
    .select("id, name, project_key, time_zone")
    .eq("org_id", ctx.org.id)
    .is("deleted_at", null)
    .order("name");
  return (data ?? []).map((r) => ({
    id: String(r["id"]),
    name: String(r["name"]),
    projectKey: String(r["project_key"]),
    timeZone: zoneOrUtc(typeof r["time_zone"] === "string" ? r["time_zone"] : null),
  }));
}

function IssueForm({
  org,
  header,
  weekEnding,
  t,
}: {
  org: string;
  header: CertifiedPayrollHeader;
  /** The default week ending: the last full week of the org's payroll week on the project's calendar. */
  weekEnding: string;
  t: T;
}) {
  return (
    <form
      method="post"
      action={`/${org}/forms/certified-payroll/${header.projectId}`}
      className="flex flex-wrap items-end gap-8"
    >
      <TextField
        id={`week-${header.projectId}`}
        name="week"
        type="date"
        label={t("weekEnding")}
        required
        defaultValue={weekEnding}
      />
      <label className="flex items-center gap-8 text-text-13">
        <input type="checkbox" name="final" />
        <span>{t("final")}</span>
      </label>
      <Button type="submit" name="format" value="pdf" variant="secondary">
        {t("pdf")}
      </Button>
      <Button type="submit" name="format" value="csv" variant="ghost">
        {t("csv")}
      </Button>
    </form>
  );
}

export async function CertifiedPayrollPanel({ ctx }: { ctx: OrgContext }) {
  if (!ctx.capabilities.has("crew.payroll.export") || !(await usComplianceFormsOn(ctx)))
    return null;
  const t = (await getTranslations("compliance.wh347")) as unknown as T;
  const projects = await listProjects(ctx);
  const headers = (
    await Promise.all(projects.map((p) => getCertifiedPayrollHeader(ctx.viewer.db, p.id)))
  ).flatMap((h) => (h.ok && h.data ? [h.data] : []));
  // The default week is the last full week of the org's payroll week (payroll.week_start, the week payroll
  // counts overtime over, 1399), on the project's calendar (its days, as app.certified_payroll counts them),
  // so the form's overtime matches what was paid; never the UTC date's Monday week.
  const weekStart = await getOrgWeekStart(ctx);
  const weekEndingOf = new Map(
    projects.map((p) => [p.id, lastWeekEnding(todayIn(p.timeZone), weekStart)]),
  );
  return (
    <section aria-labelledby="wh347-heading" className="flex flex-col gap-12">
      <header className="flex flex-col gap-4">
        <h2 id="wh347-heading" className="m-0 text-heading-16 font-semibold">
          {t("title")}
        </h2>
        <p className="m-0 text-text-secondary">{t("lead")}</p>
      </header>
      {headers.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("none")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-12 p-0">
          {headers.map((h) => (
            <li
              key={h.projectId}
              className="flex flex-col gap-8 rounded-card border border-border-subtle p-16"
            >
              <span className="text-label-14 font-medium">{h.projectName}</span>
              <span className="text-text-13 text-text-secondary">
                {t("headerLine", { contract: h.contractNumber, wd: h.wageDeterminations })}
              </span>
              <IssueForm
                org={ctx.org.slug}
                header={h}
                weekEnding={weekEndingOf.get(h.projectId) ?? ""}
                t={t}
              />
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 text-text-13 text-text-secondary">{t("stepUp")}</p>
      {projects.length > 0 ? (
        <details className="flex flex-col gap-8">
          <summary className="cursor-pointer text-text-13 font-medium">{t("headerForm")}</summary>
          <ActionForm
            action={saveCertifiedPayrollHeaderAction}
            hidden={{ org: ctx.org.slug }}
            submitLabel={t("saveHeader")}
            successKey="compliance.wh347.saved"
          >
            <SelectField
              id="wh347-project"
              name="project"
              label={t("fields.project")}
              required
              options={projects.map((p) => ({ value: p.id, label: `${p.projectKey} ${p.name}` }))}
            />
            <TextField
              id="wh347-contract"
              name="contractNumber"
              label={t("fields.contractNumber")}
              required
              maxLength={100}
            />
            <TextField
              id="wh347-wd"
              name="wageDeterminations"
              label={t("fields.wageDeterminations")}
              help={t("fields.wageDeterminationsHelp")}
              required
              maxLength={500}
            />
            <SelectField
              id="wh347-role"
              name="contractorRole"
              label={t("fields.contractorRole")}
              required
              options={[
                { value: "Prime contractor", label: t("fields.prime") },
                { value: "Subcontractor", label: t("fields.sub") },
              ]}
            />
            <TextField
              id="wh347-business"
              name="businessName"
              label={t("fields.businessName")}
              required
              maxLength={200}
            />
            <TextField
              id="wh347-address"
              name="businessAddress"
              label={t("fields.businessAddress")}
              required
              maxLength={300}
            />
            <TextField
              id="wh347-location"
              name="projectLocation"
              label={t("fields.projectLocation")}
              help={t("fields.projectLocationHelp")}
              required
              maxLength={300}
            />
          </ActionForm>
        </details>
      ) : null}
    </section>
  );
}
