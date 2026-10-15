import { listUridCategories, listVenues } from "@xos/data/places";
import {
  getLatestReconciliation,
  listCapabilityAssertionWords,
  listCapabilityStatements,
  summarizeReconciliation,
} from "@xos/data/reconciliation";
import { getFormatter } from "next-intl/server";
import { archiveCapabilityStatementAction } from "@/app/[org]/places/actions";
import type { OrgContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";
import { heldCapabilities } from "../kit/access";
import { ActionButton } from "../kit/buttons";
import { RecordSection } from "../kit/parts";
import { InlineAlert, ReconciliationTable, Tag } from "../kit/ui";
import { ReconcileForm, StatementForm } from "./statement-form";

/**
 * Requirements and capability reconciliation for one project (Section 4.5.4 Scope tab, Section 7.4,
 * journey 13). Requirements and capabilities are one shape with a direction facet; a run reconciles
 * them in the database with the silence rule (Section 3.7), and every Gap or Unknown against a
 * critical requirement is a gate 3 gap. A07 mounts this panel on the project's Scope tab.
 */
export async function ReconciliationPanel({
  ctx,
  projectId,
}: {
  ctx: OrgContext;
  projectId: string;
}) {
  const db = ctx.viewer.db;
  const [statements, latest, categories, venues, words, held, t, format] = await Promise.all([
    listCapabilityStatements(db, { projectId }),
    getLatestReconciliation(db, projectId),
    listUridCategories(db),
    listVenues(db, ctx.org.id, "live"),
    listCapabilityAssertionWords(db),
    heldCapabilities(ctx),
    getTranslate(),
    getFormatter(),
  ]);
  for (const r of [statements, latest, categories, venues, words]) {
    if (!r.ok) throw new Error(`Cannot load reconciliation: ${JSON.stringify(r.error)}`);
  }
  if (!statements.ok || !latest.ok || !categories.ok || !venues.ok || !words.ok) return null;
  const canWrite = held.has("projects.scope.write");
  const canRun = held.has("advancing.reconciliation.write");
  const name = new Map(categories.data.map((c) => [c.urid, c.name]));
  const requirements = statements.data.filter((s) => s.direction === "Require");
  const capabilities = statements.data.filter((s) => s.direction === "Provide");
  const byId = new Map(statements.data.map((s) => [s.id, s]));
  const describe = (s: (typeof statements.data)[number]) =>
    `${name.get(s.urid) ?? s.urid} ${s.urid}: ${s.description}${s.quantity === null ? "" : ` (${s.quantity})`}`;
  const venueOptions = venues.data.map((v) => ({ id: v.id, name: v.name }));
  const run = latest.data;
  const summary = run ? summarizeReconciliation(run.lines, requirements) : null;

  return (
    <section aria-labelledby="reconciliation-heading" className="flex flex-col gap-16">
      <h2 id="reconciliation-heading" className="m-0 text-heading-16 font-semibold">
        {t("places.reconciliation.title")}
      </h2>
      <p className="m-0 max-w-layout-reading text-text-13 text-text-secondary">
        {t("places.reconciliation.intro")}
      </p>

      <RecordSection id="reconciliation-run" title={t("places.reconciliation.latest")}>
        {run && summary ? (
          <div className="flex flex-col gap-12">
            <p className="m-0 text-text-13 text-text-secondary">
              {t("places.reconciliation.ranAt", {
                when: format.dateTime(new Date(run.reconciledAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </p>
            {summary.gateGaps > 0 ? (
              <InlineAlert
                tone="warning"
                title={t("places.reconciliation.gapsTitle", { count: summary.gateGaps })}
              >
                {t("places.reconciliation.gapsBody")}
              </InlineAlert>
            ) : (
              <InlineAlert tone="success">{t("places.reconciliation.noGaps")}</InlineAlert>
            )}
            <ReconciliationTable
              label={t("places.reconciliation.tableLabel")}
              rows={run.lines.map((l) => {
                const req = byId.get(l.requirementId);
                const cap = l.capabilityId ? byId.get(l.capabilityId) : undefined;
                return {
                  requirement: req ? describe(req) : l.requirementId,
                  capability: cap
                    ? `${describe(cap)} · ${t(`places.reconciliation.words.${cap.assertionWord}`)}`
                    : null,
                  result: l.result,
                };
              })}
            />
          </div>
        ) : (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("places.reconciliation.neverRun")}
          </p>
        )}
        {canRun && requirements.length > 0 ? (
          <ReconcileForm org={ctx.org.slug} projectId={projectId} />
        ) : null}
      </RecordSection>

      <RecordSection
        id="reconciliation-requirements"
        title={t("places.reconciliation.requirements")}
      >
        {requirements.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("places.reconciliation.noRequirements")}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {requirements.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-8 py-8 text-text-13"
              >
                <span className="flex flex-wrap items-center gap-6">
                  <span>{describe(s)}</span>
                  {s.critical ? (
                    <Tag tone="danger">{t("places.reconciliation.critical")}</Tag>
                  ) : null}
                </span>
                {canWrite ? (
                  <ActionButton
                    action={archiveCapabilityStatementAction}
                    org={ctx.org.slug}
                    fields={{ id: s.id }}
                    label={t("places.reconciliation.remove", { what: s.description })}
                    variant="ghost"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canWrite ? (
          <StatementForm
            org={ctx.org.slug}
            projectId={projectId}
            direction="Require"
            categories={categories.data}
            venues={venueOptions}
            words={words.data}
          />
        ) : null}
      </RecordSection>

      <RecordSection
        id="reconciliation-capabilities"
        title={t("places.reconciliation.capabilities")}
      >
        {capabilities.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("places.reconciliation.noCapabilities")}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {capabilities.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-8 py-8 text-text-13"
              >
                <span className="flex flex-wrap items-center gap-6">
                  <span>{describe(s)}</span>
                  <Tag tone={s.assertionWord === "UNKNOWN" ? "warning" : "neutral"}>
                    {t(`places.reconciliation.words.${s.assertionWord}`)}
                  </Tag>
                </span>
                {canWrite ? (
                  <ActionButton
                    action={archiveCapabilityStatementAction}
                    org={ctx.org.slug}
                    fields={{ id: s.id }}
                    label={t("places.reconciliation.remove", { what: s.description })}
                    variant="ghost"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canWrite && venueOptions.length > 0 ? (
          <StatementForm
            org={ctx.org.slug}
            projectId={projectId}
            direction="Provide"
            categories={categories.data}
            venues={venueOptions}
            words={words.data}
          />
        ) : null}
      </RecordSection>
    </section>
  );
}
