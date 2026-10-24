import {
  listMySupplierDiversity,
  listSupplierDiversityPrograms,
  SUPPLIER_DIVERSITY_KINDS,
} from "@xos/data/supplier-diversity";
import type { XosClient } from "@xos/data";
import { ActionButton } from "@/components/actions/action-button";
import { RowList } from "@/components/engagement/rows";
import { SimpleForm } from "@/components/forms/simple-form";
import { RegionError, Section } from "@/components/page/page";
import {
  addSupplierDiversityAction,
  removeSupplierDiversityAction,
  revokeSupplierDiversityShareAction,
  shareSupplierDiversityAction,
} from "@/lib/actions/supplier-diversity";
import { formatDate } from "@/lib/format";
import { enumLabelKey, type Translate } from "@/lib/shell/translate";

/**
 * Supplier diversity certifications (Section 4.4.1, A65-031): optional and self-declared, for the
 * person or for the company they act as. Each is shared one organization at a time, by separate
 * consent, and only with an organization that runs a supplier diversity program; every share can be
 * revoked here. The certificate number is Restricted, so only its last four characters show.
 */
export async function SupplierDiversityPanel({
  db,
  t,
  locale,
  accountId,
}: {
  db: XosClient;
  t: Translate;
  locale: string;
  /** The company acted as, or null for the person's own. */
  accountId: string | null;
}) {
  const [certs, programs] = await Promise.all([
    listMySupplierDiversity(db, accountId),
    listSupplierDiversityPrograms(db, accountId),
  ]);
  return (
    <Section id="supplier-diversity" title={t("gateway.diversity.title")}>
      <p className="m-0 text-text-13 text-text-secondary">{t("gateway.diversity.lead")}</p>
      {!certs.ok || !programs.ok ? (
        <RegionError />
      ) : (
        <>
          {certs.data.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("gateway.diversity.empty")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-12 p-0">
              {certs.data.map((c) => {
                const unshared = programs.data.filter(
                  (p) => !c.shares.some((s) => s.orgId === p.orgId),
                );
                return (
                  <li
                    key={c.id}
                    className="flex flex-col gap-8 rounded-card border border-border-subtle bg-bg-raised p-12"
                  >
                    <div className="flex flex-wrap items-center gap-8">
                      <strong className="text-text-14">
                        {t(enumLabelKey("supplierDiversityKind", c.kind))}
                      </strong>
                      <span className="text-text-13 text-text-secondary">
                        {[
                          c.certifyingBody,
                          c.numberLast4
                            ? t("gateway.diversity.numberLast4", { last4: c.numberLast4 })
                            : null,
                          c.expiresOn
                            ? t("gateway.engagement.documents.expires", {
                                date: formatDate(locale, c.expiresOn),
                              })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      <span className="ms-auto">
                        <ActionButton
                          action={removeSupplierDiversityAction.bind(null, c.id)}
                          label={t("gateway.diversity.remove")}
                          variant="ghost"
                        />
                      </span>
                    </div>
                    {c.shares.length > 0 ? (
                      <RowList
                        label={t("gateway.diversity.sharedWith")}
                        items={c.shares.map((s) => ({
                          id: s.shareId,
                          title: s.orgName,
                          meta: [
                            t("gateway.diversity.sharedOn", {
                              date: formatDate(locale, s.sharedAt),
                            }),
                          ],
                          action: (
                            <ActionButton
                              action={revokeSupplierDiversityShareAction.bind(null, s.shareId)}
                              label={t("gateway.diversity.revoke")}
                              variant="ghost"
                            />
                          ),
                        }))}
                      />
                    ) : (
                      <p className="m-0 text-text-13 text-text-secondary">
                        {t("gateway.diversity.notShared")}
                      </p>
                    )}
                    {unshared.length > 0 ? (
                      <SimpleForm
                        id={`diversity-share-${c.id}`}
                        action={shareSupplierDiversityAction}
                        label={t("gateway.diversity.shareLabel")}
                        errorsNamespace="gateway.diversity.errors"
                        variant="secondary"
                        submitLabel={t("gateway.diversity.share")}
                        doneLabel={t("gateway.diversity.shared")}
                        hidden={{ certificationId: c.id }}
                        fields={[
                          {
                            name: "orgId",
                            label: t("gateway.diversity.shareWith"),
                            kind: "select",
                            required: true,
                            help: t("gateway.diversity.consent"),
                            options: unshared.map((p) => ({ value: p.orgId, label: p.orgName })),
                          },
                        ]}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {programs.data.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {t("gateway.diversity.noPrograms")}
            </p>
          ) : null}
          <SimpleForm
            id="diversity-add"
            action={addSupplierDiversityAction}
            label={t("gateway.diversity.add")}
            errorsNamespace="gateway.diversity.errors"
            variant="secondary"
            resetOnDone
            submitLabel={t("gateway.diversity.add")}
            doneLabel={t("gateway.diversity.added")}
            fields={[
              {
                name: "kind",
                label: t("gateway.diversity.kind"),
                kind: "select",
                required: true,
                options: SUPPLIER_DIVERSITY_KINDS.map((k) => ({
                  value: k,
                  label: t(enumLabelKey("supplierDiversityKind", k)),
                })),
              },
              {
                name: "certifyingBody",
                label: t("gateway.diversity.certifyingBody"),
                help: t("gateway.diversity.certifyingBodyHelp"),
                required: true,
              },
              {
                name: "certificateNumber",
                label: t("gateway.diversity.number"),
                help: t("gateway.diversity.numberHelp"),
                autoComplete: "off",
              },
              { name: "issuedOn", label: t("gateway.diversity.issuedOn"), kind: "date" },
              { name: "expiresOn", label: t("gateway.diversity.expiresOn"), kind: "date" },
            ]}
          />
        </>
      )}
    </Section>
  );
}
