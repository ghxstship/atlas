import type { XosClient } from "@xos/data";
import { listEngagementInsuredChecks } from "@xos/data/insureds";
import { getTranslations } from "next-intl/server";
import { verifyInsuredsAction } from "@/app/[org]/opportunities/insured-actions";
import { ActionForm } from "@/components/opportunities/action-form";
import { Tag } from "@/components/opportunities/ui";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Journey 43's additional insureds step on a vendor engagement (finding A38-001): each party the
 * org requires on the project, whether a current certificate names it, and, for a reviewer, the
 * verification of an open onboarding item against them. Renders nothing for an engagement with
 * no requirement (a party that is not a vendor, or an org that requires none).
 */
export async function EngagementInsureds({
  db,
  orgSlug,
  engagementId,
  items,
  canVerify,
}: {
  db: XosClient;
  orgSlug: string;
  engagementId: string;
  /** Reviewer items of the engagement that do not pass yet. */
  items: readonly { readonly itemId: string; readonly name: string }[];
  canVerify: boolean;
}) {
  const [checks, translate] = await Promise.all([
    listEngagementInsuredChecks(db, engagementId),
    getTranslations("opportunities"),
  ]);
  const t = translate as unknown as Translate;
  if (!checks.ok) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("insureds.loadFailed")}</p>;
  }
  if (checks.data.length === 0) return null;
  return (
    <section aria-labelledby={`insureds-${engagementId}`} className="flex flex-col gap-8">
      <h3 id={`insureds-${engagementId}`} className="m-0 text-heading-14 font-semibold">
        {t("insureds.title")}
      </h3>
      <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
        {checks.data.map((c) => (
          <li key={c.requiredInsuredId} className="flex flex-wrap items-center gap-8">
            <span className="font-medium">{c.insuredName}</span>
            <span className="text-text-secondary">
              {t(`insureds.endorsements.${c.endorsementKind.replaceAll(" ", "")}`)}
            </span>
            <Tag tone={c.namedOnCertificateId ? "success" : "danger"}>
              {c.namedOnCertificateId ? t("insureds.named") : t("insureds.missing")}
            </Tag>
          </li>
        ))}
      </ul>
      {canVerify
        ? items.map((i) => (
            <ActionForm
              key={i.itemId}
              action={verifyInsuredsAction}
              hidden={{ org: orgSlug, itemId: i.itemId }}
              fields={[]}
              inline
              submitLabel={t("insureds.verify", { item: i.name })}
              successLabel={t("insureds.verified")}
            />
          ))
        : null}
    </section>
  );
}
