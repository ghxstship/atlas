import {
  ENDORSEMENT_KINDS,
  listCertificateChecks,
  listCertificateInsureds,
  listRequiredInsureds,
  type EndorsementKind,
} from "@xos/data/insureds";
import { listProjects } from "@xos/data/projects";
import {
  addCertificateInsuredAction,
  addRequiredInsuredAction,
  removeCertificateInsuredAction,
  removeRequiredInsuredAction,
} from "@/app/[org]/vendors/insured-actions";
import { ActionButton, EntityForm, ErrorPanel, KitSection } from "@/components/collection-kit/kit";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import type { OrgContext } from "@/lib/shell/context";

const REFUSALS = "vendors.refusals";

function endorsementOptions(t: Copy) {
  return ENDORSEMENT_KINDS.map((k) => ({ value: k, label: endorsementLabel(t, k) }));
}

function endorsementLabel(t: Copy, kind: EndorsementKind): string {
  return t(`insureds.endorsements.${kind.replaceAll(" ", "")}`);
}

/**
 * The parties a certificate names (finding A38-001, journey 43), whether it names every party the
 * org requires org-wide, and, with vendors.coi.write, adding and removing named parties.
 */
export async function CertificateInsureds({
  ctx,
  certificateId,
}: {
  ctx: OrgContext;
  certificateId: string;
}) {
  const db = ctx.viewer.db;
  const [t, insureds, checks] = await Promise.all([
    getCopy("vendors"),
    listCertificateInsureds(db, [certificateId]),
    listCertificateChecks(db, ctx.org.id),
  ]);
  if (!insureds.ok || !checks.ok) return <ErrorPanel what={t("insureds.what")} />;
  const canWrite = ctx.capabilities.has("vendors.coi.write");
  const check = checks.data.find((c) => c.certificateId === certificateId);
  return (
    <KitSection id={`insureds-${certificateId}`} title={t("insureds.title")}>
      {check && check.requiredCount > 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {check.insuredsVerified
            ? t("insureds.verified")
            : t("insureds.missing", { count: check.missingCount })}
        </p>
      ) : null}
      {insureds.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {canWrite ? t("insureds.empty") : t("insureds.emptyRead")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0" aria-label={t("insureds.title")}>
          {insureds.data.map((n) => (
            <li
              key={n.id}
              className="flex flex-wrap items-center justify-between gap-8 rounded-card border border-border-subtle p-8 text-text-13"
            >
              <span>
                <span className="font-medium">{n.insuredName}</span>
                <span className="text-text-secondary">
                  {" "}
                  · {endorsementLabel(t, n.endorsementKind)}
                </span>
              </span>
              {canWrite ? (
                <ActionButton
                  action={removeCertificateInsuredAction}
                  hidden={{ org: ctx.org.slug, id: n.id }}
                  label={t("insureds.remove", { name: n.insuredName })}
                  variant="ghost"
                  refusals={REFUSALS}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <EntityForm
          id={`insured-add-${certificateId}`}
          action={addCertificateInsuredAction}
          hidden={{ org: ctx.org.slug, certificateId }}
          refusals={REFUSALS}
          submitLabel={t("insureds.add")}
          fields={[
            {
              kind: "text",
              name: "insuredName",
              label: t("insureds.name"),
              help: t("insureds.nameHelp"),
              required: true,
            },
            {
              kind: "select",
              name: "endorsementKind",
              label: t("insureds.endorsement"),
              defaultValue: "Additional Insured",
              options: endorsementOptions(t),
            },
          ]}
        />
      ) : null}
    </KitSection>
  );
}

/**
 * The parties the org requires its vendors' certificates to name, org-wide or for one project;
 * the reviewer's verification step on a vendor engagement checks against them.
 */
export async function RequiredInsureds({ ctx }: { ctx: OrgContext }) {
  const db = ctx.viewer.db;
  const [t, required, projects] = await Promise.all([
    getCopy("vendors"),
    listRequiredInsureds(db, ctx.org.id),
    listProjects(db, ctx.org.id),
  ]);
  if (!required.ok || !projects.ok) return <ErrorPanel what={t("insureds.requiredWhat")} />;
  const canWrite = ctx.capabilities.has("vendors.coi.write");
  return (
    <KitSection id="required-insureds" title={t("insureds.requiredTitle")}>
      <p className="m-0 text-text-13 text-text-secondary">{t("insureds.requiredSentence")}</p>
      {required.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {canWrite ? t("insureds.requiredEmpty") : t("insureds.requiredEmptyRead")}
        </p>
      ) : (
        <ul
          className="m-0 flex list-none flex-col gap-4 p-0"
          aria-label={t("insureds.requiredTitle")}
        >
          {required.data.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-8 rounded-card border border-border-subtle p-8 text-text-13"
            >
              <span>
                <span className="font-medium">{r.insuredName}</span>
                <span className="text-text-secondary">
                  {" "}
                  · {endorsementLabel(t, r.endorsementKind)} ·{" "}
                  {r.projectName ?? t("insureds.everyProject")}
                </span>
              </span>
              {canWrite ? (
                <ActionButton
                  action={removeRequiredInsuredAction}
                  hidden={{ org: ctx.org.slug, id: r.id }}
                  label={t("insureds.remove", { name: r.insuredName })}
                  variant="ghost"
                  refusals={REFUSALS}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <EntityForm
          id="required-insured-add"
          action={addRequiredInsuredAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("insureds.requiredAdd")}
          fields={[
            {
              kind: "text",
              name: "insuredName",
              label: t("insureds.name"),
              help: t("insureds.requiredNameHelp"),
              required: true,
            },
            {
              kind: "select",
              name: "endorsementKind",
              label: t("insureds.endorsement"),
              defaultValue: "Additional Insured",
              options: endorsementOptions(t),
            },
            {
              kind: "select",
              name: "projectId",
              label: t("insureds.project"),
              blankLabel: t("insureds.everyProject"),
              defaultValue: "",
              options: projects.data.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
            },
          ]}
        />
      ) : null}
    </KitSection>
  );
}
