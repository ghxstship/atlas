import {
  APP_ENUMS,
  bidTotal,
  listMyApplications,
  listOnboardingItems,
  onboardingStanding,
  readView,
} from "@xos/data/gateway";
import { ActionButton } from "@/components/actions/action-button";
import { RegionError, Section } from "@/components/page/page";
import { InlineAlert, Tag } from "@/components/ui";
import { acknowledgePurchaseOrderAction } from "@/lib/actions/operations";
import { hasArea, isLiveEngagement, tabHref } from "@/lib/engagement";
import { formatDate, formatDateRange, formatDateTime, formatMoney } from "@/lib/format";
import { enumLabelKey } from "@/lib/shell/translate";
import { toneFor } from "@/lib/states";
import { OnboardingUploadForm, SubmittalResponseForm, TaxFormForm } from "./forms";
import { canUpload, isUpload } from "./tabs-common";
import { AreaClosed, RowList, TabEmpty } from "./rows";
import type { TabProps } from "./tab-context";
import { DocumentActions } from "@/components/documents/document-actions";

/**
 * Vendor tabs (Section 4.4.4 Vendor: bid, purchase orders with acknowledgment, deliveries and dock
 * slots, submittals, advance, compliance). The bid tab shows only the vendor's own sealed bid.
 */

export async function BidTab({ view, t, locale, engagementKey }: TabProps) {
  const apps = await listMyApplications(view.ctx.db);
  if (!apps.ok) return <RegionError />;
  const bids = apps.data.filter((a) => a.bid && a.opportunity?.orgId === view.engagement.orgId);
  if (bids.length === 0) {
    return (
      <TabEmpty
        icon="Gavel"
        sentence={t("gateway.engagement.bid.empty")}
        actionLabel={t("gateway.engagement.poAction")}
        href={tabHref(engagementKey, "engagement.purchase-orders")}
      />
    );
  }
  return (
    <div className="flex flex-col gap-16">
      {bids.map((a) => (
        <Section key={a.id} id={`bid-${a.id}`} title={a.opportunity?.title ?? a.key}>
          <p className="m-0 text-text-13 text-text-secondary">
            {t("gateway.engagement.bid.summary", {
              date: formatDate(locale, a.bid?.submittedAt ?? a.submittedAt),
              total:
                formatMoney(locale, a.bid ? bidTotal(a.bid.lines) : null, a.bid?.currency) ??
                t("gateway.common.unpriced"),
            })}
          </p>
          <RowList
            label={a.opportunity?.title ?? a.key}
            items={(a.bid?.lines ?? []).map((l) => ({
              id: l.id,
              title: l.description,
              meta: [
                t("gateway.engagement.bid.quantity", { n: l.quantity }),
                formatMoney(locale, l.unitPriceMinor, a.bid?.currency) ??
                  t("gateway.common.unpriced"),
              ],
            }))}
          />
        </Section>
      ))}
    </div>
  );
}

export async function PurchaseOrdersTab({ view, t, locale, engagementKey }: TabProps) {
  const pos = await readView(view.ctx.db, "purchase_orders", {
    eq: { project_id: view.engagement.projectId, org_id: view.engagement.orgId },
    order: ["po_number", "desc"],
  });
  if (!pos.ok) return <RegionError />;
  // Acknowledging a PO is operational work: offered only while the engagement is live (Section 8.7).
  const live = isLiveEngagement(view.engagement.state);
  const ids = pos.data.flatMap((p) => (p.id ? [p.id] : []));
  const lines = await readView(view.ctx.db, "po_lines", {
    in: ["purchase_order_id", ids],
    order: ["line_number", "asc"],
  });
  if (!lines.ok) return <RegionError />;
  if (pos.data.length === 0) {
    return (
      <TabEmpty
        icon="FileText"
        sentence={t("gateway.engagement.po.empty")}
        actionLabel={t("gateway.engagement.messagesAction")}
        href={tabHref(engagementKey, "engagement.messages")}
      />
    );
  }
  return (
    <RowList
      label={t("nav.gateway.engagementTabs.purchaseOrders")}
      items={pos.data.map((po) => ({
        id: po.id ?? "",
        title: t("gateway.engagement.po.number", { n: po.po_number ?? 0 }),
        meta: [
          formatMoney(locale, po.total_minor, po.currency_code) ?? t("gateway.common.unpriced"),
          po.sent_at
            ? t("gateway.engagement.po.sent", { date: formatDate(locale, po.sent_at) })
            : null,
          po.acknowledged_at
            ? t("gateway.engagement.po.acknowledged", {
                date: formatDate(locale, po.acknowledged_at),
              })
            : null,
        ],
        ...(po.po_state
          ? { tag: { label: t(enumLabelKey("poState", po.po_state)), tone: toneFor(po.po_state) } }
          : {}),
        ...(po.po_state === "Sent" && !po.acknowledged_at && po.id && live
          ? {
              action: (
                <ActionButton
                  action={acknowledgePurchaseOrderAction.bind(null, po.id)}
                  label={t("gateway.engagement.po.acknowledge")}
                  variant="secondary"
                />
              ),
            }
          : {}),
        detail: (
          <div className="flex flex-col gap-8">
            <ul className="m-0 flex list-none flex-col gap-2 ps-12 text-text-13 text-text-secondary">
              {lines.data
                .filter((l) => l.purchase_order_id === po.id)
                .map((l) => (
                  <li key={l.id ?? ""}>
                    {[
                      t("gateway.engagement.po.line", {
                        n: l.line_number ?? 0,
                        description: l.description ?? "",
                      }),
                      [l.quantity, l.unit_basis]
                        .filter((v) => v !== null && v !== undefined)
                        .join(" "),
                      formatMoney(locale, l.amount_minor, po.currency_code) ??
                        t("gateway.common.unpriced"),
                    ].join(" · ")}
                  </li>
                ))}
            </ul>
            {po.id ? (
              <DocumentActions kind="purchase-order" id={po.id} engagementKey={engagementKey} />
            ) : null}
          </div>
        ),
      }))}
    />
  );
}

export async function DeliveriesTab({ view, t, locale, engagementKey }: TabProps) {
  if (!hasArea(view, "operational")) {
    return <AreaClosed view={view} t={t} engagementKey={engagementKey} />;
  }
  const [docks, deliveries] = await Promise.all([
    readView(view.ctx.db, "dock_slots", {
      eq: { engagement_id: view.engagement.id },
      order: ["starts_at", "asc"],
    }),
    readView(view.ctx.db, "deliveries", {
      eq: { project_id: view.engagement.projectId },
      order: ["arrives_at", "asc"],
    }),
  ]);
  if (!docks.ok || !deliveries.ok) return <RegionError />;
  if (docks.data.length === 0 && deliveries.data.length === 0) {
    return (
      <TabEmpty
        icon="Truck"
        sentence={t("gateway.engagement.deliveries.empty")}
        actionLabel={t("gateway.engagement.messagesAction")}
        href={tabHref(engagementKey, "engagement.messages")}
      />
    );
  }
  return (
    <div className="flex flex-col gap-16">
      {docks.data.length > 0 ? (
        <Section title={t("gateway.engagement.deliveries.docks")}>
          <RowList
            label={t("gateway.engagement.deliveries.docks")}
            items={docks.data.map((d) => ({
              id: d.id ?? "",
              title: d.zone_name ?? d.zone_code ?? "",
              meta: [
                d.starts_at ? formatDateTime(locale, d.starts_at) : null,
                d.ends_at ? formatDateTime(locale, d.ends_at) : null,
                d.tracking_identifier,
              ],
              ...(d.direction
                ? {
                    tag: {
                      label: t(enumLabelKey("shipmentDirection", d.direction)),
                      tone: "neutral" as const,
                    },
                  }
                : {}),
            }))}
          />
        </Section>
      ) : null}
      {deliveries.data.length > 0 ? (
        <Section title={t("gateway.engagement.deliveries.shipments")}>
          <RowList
            label={t("gateway.engagement.deliveries.shipments")}
            items={deliveries.data.map((d) => ({
              id: d.id ?? "",
              title: d.tracking_identifier ?? d.project_name ?? "",
              meta: [
                d.ships_at ? formatDateTime(locale, d.ships_at) : null,
                d.arrives_at ? formatDateTime(locale, d.arrives_at) : null,
              ],
              ...(d.direction
                ? {
                    tag: {
                      label: t(enumLabelKey("shipmentDirection", d.direction)),
                      tone: "neutral" as const,
                    },
                  }
                : {}),
            }))}
          />
        </Section>
      ) : null}
    </div>
  );
}

/**
 * Submittals (Section 4.4.4 Vendor): what the org asked the vendor's account to submit on the
 * project. The vendor submits a Proposed one or resubmits a Returned one with a note; a Returned one
 * shows what to change.
 */
export async function SubmittalsTab({ view, t, locale, engagementKey }: TabProps) {
  if (!hasArea(view, "operational")) {
    return <AreaClosed view={view} t={t} engagementKey={engagementKey} />;
  }
  const submittals = view.engagement.accountId
    ? await readView(view.ctx.db, "submittals", {
        eq: { project_id: view.engagement.projectId, account_id: view.engagement.accountId },
        order: ["due_on", "asc"],
      })
    : null;
  if (submittals && !submittals.ok) return <RegionError />;
  const rows = submittals?.ok ? submittals.data : [];
  if (rows.length === 0) {
    return (
      <TabEmpty
        icon="FileCheck"
        sentence={t("gateway.engagement.submittals.empty")}
        actionLabel={t("gateway.engagement.documentsAction")}
        href={tabHref(engagementKey, "engagement.documents")}
      />
    );
  }
  return (
    <RowList
      label={t("nav.gateway.engagementTabs.submittals")}
      items={rows.map((s) => ({
        id: s.id ?? "",
        title: s.title ?? "",
        meta: [
          s.submittal_kind ? t(enumLabelKey("submittalKind", s.submittal_kind)) : null,
          t("gateway.engagement.submittals.revision", { n: s.revision ?? 0 }),
          s.due_on ? t("gateway.engagement.due", { date: formatDate(locale, s.due_on) }) : null,
        ],
        ...(s.submittal_state
          ? {
              tag: {
                label: t(enumLabelKey("reviewState", s.submittal_state)),
                tone: toneFor(s.submittal_state),
              },
            }
          : {}),
        detail: <SubmittalDetail row={s} t={t} />,
      }))}
    />
  );
}

function SubmittalDetail({
  row,
  t,
}: {
  row: {
    id: string | null;
    title: string | null;
    submittal_state: string | null;
    return_reason: string | null;
  };
  t: TabProps["t"];
}) {
  if (!row.id) return null;
  if (row.submittal_state === "Returned") {
    return (
      <div className="flex flex-col gap-8">
        <InlineAlert tone="warning">
          {t("gateway.engagement.submittals.returned", { reason: row.return_reason ?? "" })}
        </InlineAlert>
        <SubmittalResponseForm submittalId={row.id} title={row.title ?? ""} expected="Returned" />
      </div>
    );
  }
  if (row.submittal_state === "Proposed") {
    return (
      <SubmittalResponseForm submittalId={row.id} title={row.title ?? ""} expected="Proposed" />
    );
  }
  if (row.submittal_state === "Submitted") {
    return (
      <p className="m-0 text-text-13 text-text-secondary">
        {t("gateway.engagement.submittals.awaiting")}
      </p>
    );
  }
  return null;
}

/** Vendor compliance (Section 4.4.4): insurance certificates, prequalification and compliance items. */
export async function ComplianceTab({ view, t, locale, engagementKey }: TabProps) {
  const [insurance, prequal, items] = await Promise.all([
    readView(view.ctx.db, "vendor_insurance_certificates", {
      eq: { org_id: view.engagement.orgId },
      order: ["valid_to", "desc"],
    }),
    readView(view.ctx.db, "vendor_prequalifications", { eq: { org_id: view.engagement.orgId } }),
    listOnboardingItems(view.ctx.db, view.engagement.id),
  ]);
  if (!insurance.ok || !prequal.ok || !items.ok) return <RegionError />;
  const insureds = await readView(view.ctx.db, "vendor_certificate_insureds", {
    in: ["certificate_id", insurance.data.flatMap((c) => (c.id ? [c.id] : []))],
    order: ["insured_name", "asc"],
  });
  if (!insureds.ok) return <RegionError />;
  const compliance = items.data.filter(isUpload);
  // Vendors have no Onboarding tab, so an open document or certificate is uploaded here (R2).
  const toUpload = hasArea(view, "onboarding")
    ? compliance.filter((i) => canUpload(i, view.today))
    : [];
  const onFile = compliance.filter((i) => !toUpload.includes(i));
  // Vendors have no Onboarding tab, so an open tax form step (journey 43's W-9) is filed here.
  const taxStep = items.data.find((i) => i.kind === "Tax Form" && !i.satisfied);
  if (
    insurance.data.length === 0 &&
    prequal.data.length === 0 &&
    compliance.length === 0 &&
    !taxStep
  ) {
    return (
      <TabEmpty
        icon="ShieldCheck"
        sentence={t("gateway.engagement.compliance.empty")}
        actionLabel={t("gateway.engagement.onboardingAction")}
        href={tabHref(engagementKey, "engagement.overview")}
      />
    );
  }
  return (
    <div className="flex flex-col gap-16">
      {taxStep ? (
        <Section title={taxStep.name}>
          <TaxFormForm
            orgId={view.engagement.orgId}
            asAccount={view.ctx.acting !== null}
            kinds={APP_ENUMS.tax_form_kind.map((k) => ({
              value: k,
              label: t(enumLabelKey("taxFormKind", k)),
            }))}
          />
        </Section>
      ) : null}
      <Section title={t("gateway.engagement.compliance.insurance")}>
        {insurance.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("gateway.engagement.compliance.noInsurance")}
          </p>
        ) : (
          <RowList
            label={t("gateway.engagement.compliance.insurance")}
            items={insurance.data.map((c) => ({
              id: c.id ?? "",
              title: c.coverage_type ?? c.insurer ?? "",
              meta: [
                c.insurer,
                c.policy_identifier,
                formatMoney(locale, c.coverage_limit_minor, c.currency_code),
                formatDateRange(locale, c.valid_from, c.valid_to),
              ],
              tag: c.is_current
                ? { label: t("gateway.engagement.compliance.current"), tone: "success" as const }
                : { label: t("gateway.engagement.compliance.expired"), tone: "danger" as const },
              detail: (
                <CertificateInsureds
                  t={t}
                  names={insureds.data
                    .filter((n) => n.certificate_id === c.id)
                    .map((n) => ({
                      id: n.id ?? "",
                      name: n.insured_name ?? "",
                      endorsement: t(enumLabelKey("endorsementKind", n.endorsement_kind ?? "")),
                    }))}
                />
              ),
            }))}
          />
        )}
      </Section>
      {prequal.data.length > 0 ? (
        <Section title={t("gateway.engagement.compliance.prequalification")}>
          <RowList
            label={t("gateway.engagement.compliance.prequalification")}
            items={prequal.data.map((p) => ({
              id: p.id ?? "",
              title: p.scope ?? "",
              meta: [
                p.valid_to
                  ? t("gateway.engagement.compliance.validTo", {
                      date: formatDate(locale, p.valid_to),
                    })
                  : null,
              ],
              ...(p.decision
                ? {
                    tag: {
                      label: t(enumLabelKey("approvalDecision", p.decision)),
                      tone: toneFor(p.decision),
                    },
                  }
                : {}),
            }))}
          />
        </Section>
      ) : null}
      {compliance.length > 0 ? (
        <Section title={t("gateway.engagement.compliance.items")}>
          {toUpload.length > 0 ? (
            <RowList
              label={t("gateway.engagement.compliance.items")}
              items={toUpload.map((i) => ({
                id: i.id,
                title: i.name,
                meta: [
                  t(enumLabelKey("onboardingItemKind", i.kind)),
                  i.blocking ? t("gateway.engagement.onboarding.blocking") : null,
                ],
                tag: {
                  label: t(
                    `gateway.engagement.onboarding.standing.${onboardingStanding(i, view.today)}`,
                  ),
                  tone: onboardingStanding(i, view.today) === "expired" ? "danger" : "warning",
                },
                detail: (
                  <OnboardingUploadForm
                    orgId={view.engagement.orgId}
                    engagementId={view.engagement.id}
                    itemId={i.id}
                    name={i.name}
                  />
                ),
              }))}
            />
          ) : null}
          {onFile.length > 0 ? (
            <ul className="m-0 flex list-none flex-wrap gap-8 p-0">
              {onFile.map((i) => (
                <li key={i.id}>
                  <Tag tone={i.satisfied ? "success" : "warning"}>{i.name}</Tag>
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

/** The parties a certificate on file names (finding A38-001), as the org recorded them. */
function CertificateInsureds({
  t,
  names,
}: {
  t: TabProps["t"];
  names: readonly { id: string; name: string; endorsement: string }[];
}) {
  if (names.length === 0) {
    return (
      <p className="m-0 text-text-13 text-text-secondary">
        {t("gateway.engagement.compliance.noInsureds")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <span className="text-text-12 font-medium">
        {t("gateway.engagement.compliance.insureds")}
      </span>
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-text-13">
        {names.map((n) => (
          <li key={n.id}>{t("gateway.engagement.compliance.insuredLine", n)}</li>
        ))}
      </ul>
    </div>
  );
}
