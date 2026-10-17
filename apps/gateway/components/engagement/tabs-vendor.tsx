import {
  APP_ENUMS,
  bidTotal,
  listMyApplications,
  listOnboardingItems,
  listSharedRecords,
  readView,
} from "@xos/data/gateway";
import { ActionButton } from "@/components/actions/action-button";
import { RegionError, Section } from "@/components/page/page";
import { Tag } from "@/components/ui";
import { acknowledgePurchaseOrderAction } from "@/lib/actions/operations";
import { hasArea, tabHref } from "@/lib/engagement";
import { formatDate, formatDateRange, formatDateTime, formatMoney } from "@/lib/format";
import { enumLabelKey } from "@/lib/shell/translate";
import { toneFor } from "@/lib/states";
import { AdvanceAnswerForm, TaxFormForm } from "./forms";
import { RowList, TabEmpty } from "./rows";
import type { TabProps } from "./tab-context";

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
        ...(po.po_state === "Sent" && !po.acknowledged_at && po.id
          ? {
              action: (
                <ActionButton
                  action={acknowledgePurchaseOrderAction.bind(null, po.id)}
                  label={t("gateway.engagement.po.acknowledge")}
                  variant="primary"
                />
              ),
            }
          : {}),
        detail: (
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
        ),
      }))}
    />
  );
}

export async function DeliveriesTab({ view, t, locale, engagementKey }: TabProps) {
  if (!hasArea(view, "operational")) {
    return (
      <TabEmpty
        icon="Lock"
        sentence={t("gateway.engagement.operationalClosed")}
        actionLabel={t("gateway.engagement.onboardingAction")}
        href={tabHref(engagementKey, "engagement.overview")}
      />
    );
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
 * Submittals: no submittal table exists yet (A16 adds it in 0490 to 0499), so the tab shows the
 * project records the org shared for review, which is where submittal requests arrive today.
 */
export async function SubmittalsTab({ view, t, locale, engagementKey }: TabProps) {
  const records = hasArea(view, "operational")
    ? await listSharedRecords(view.ctx.db, {
        projectIds: [view.engagement.projectId],
        kinds: ["Approval", "Document", "Compliance"],
      })
    : null;
  if (records && !records.ok) return <RegionError />;
  const rows = records?.ok ? records.data : [];
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
      items={rows.map((r) => ({
        id: r.id,
        title: r.title,
        meta: [
          t(enumLabelKey("recordKind", r.kind)),
          r.dueAt
            ? t("gateway.engagement.due", { date: formatDateTime(locale, r.dueAt, r.timeZone) })
            : null,
        ],
        tag: { label: t(enumLabelKey("recordState", r.state)), tone: toneFor(r.state) },
      }))}
    />
  );
}

/** The advance packet (Section 4.4.4 Artist and Vendor): each section, its answer and its review. */
export async function AdvanceTab({ view, t, locale, engagementKey }: TabProps) {
  const [packets, recipients] = await Promise.all([
    readView(view.ctx.db, "advance_packets", {
      eq: { project_id: view.engagement.projectId },
      order: ["due_at", "asc"],
    }),
    readView(view.ctx.db, "my_advance_recipients", {}),
  ]);
  if (!packets.ok || !recipients.ok) return <RegionError />;
  const packetIds = packets.data.flatMap((p) => (p.id ? [p.id] : []));
  const [sections, submissions] = await Promise.all([
    readView(view.ctx.db, "advance_sections", {
      in: ["advance_packet_id", packetIds],
      order: ["position", "asc"],
    }),
    readView(view.ctx.db, "advance_submissions", { order: ["submitted_at", "desc"] }),
  ]);
  if (!sections.ok || !submissions.ok) return <RegionError />;
  if (packets.data.length === 0) {
    return (
      <TabEmpty
        icon="ClipboardList"
        sentence={t("gateway.engagement.advance.empty")}
        actionLabel={t("gateway.engagement.messagesAction")}
        href={tabHref(engagementKey, "engagement.messages")}
      />
    );
  }
  return (
    <div className="flex flex-col gap-24">
      {packets.data.map((packet) => {
        const recipient = recipients.data.find((r) => r.advance_packet_id === packet.id);
        return (
          <Section key={packet.id ?? ""} id={`packet-${packet.id}`} title={packet.title ?? ""}>
            {packet.due_at ? (
              <p className="m-0 text-text-13 text-text-secondary">
                {t("gateway.engagement.due", { date: formatDateTime(locale, packet.due_at) })}
              </p>
            ) : null}
            <RowList
              label={packet.title ?? ""}
              items={sections.data
                .filter((s) => s.advance_packet_id === packet.id)
                .map((s) => {
                  const latest = submissions.data.find(
                    (sub) =>
                      sub.advance_section_id === s.id &&
                      (!recipient || sub.advance_recipient_id === recipient.id),
                  );
                  const returned = latest?.review_outcome === "Returned";
                  return {
                    id: s.id ?? "",
                    title: `${s.position}. ${s.title ?? ""}`,
                    meta: [s.prompt],
                    ...(latest
                      ? {
                          tag: latest.review_outcome
                            ? {
                                label: t(
                                  enumLabelKey("advanceReviewOutcome", latest.review_outcome),
                                ),
                                tone: toneFor(
                                  latest.review_outcome === "Accepted" ? "Accepted" : "Returned",
                                ),
                              }
                            : {
                                label: t("gateway.engagement.advance.awaitingReview"),
                                tone: "accent" as const,
                              },
                        }
                      : {}),
                    detail: (
                      <div className="flex flex-col gap-8">
                        {latest ? (
                          <p className="m-0 whitespace-pre-line rounded-control bg-bg-surface p-8 text-text-13">
                            {latest.body}
                          </p>
                        ) : null}
                        {returned && latest?.return_reason ? (
                          <p className="m-0 text-text-13 text-danger-text">
                            {latest.return_reason}
                          </p>
                        ) : null}
                        {recipient?.id && s.id && (!latest || returned) ? (
                          <AdvanceAnswerForm
                            recipientId={recipient.id}
                            sectionId={s.id}
                            prompt={s.title ?? ""}
                          />
                        ) : null}
                      </div>
                    ),
                  };
                })}
            />
          </Section>
        );
      })}
    </div>
  );
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
  const compliance = items.data.filter(
    (i) => i.kind === "Document Upload" || i.kind === "Certification",
  );
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
          <ul className="m-0 flex list-none flex-wrap gap-8 p-0">
            {compliance.map((i) => (
              <li key={i.id}>
                <Tag tone={i.satisfied ? "success" : "warning"}>{i.name}</Tag>
              </li>
            ))}
          </ul>
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
