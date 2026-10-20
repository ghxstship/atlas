import { getSubscription, listMembers } from "@xos/data";
import {
  getDeletionRequest,
  getOpenOwnershipTransfer,
  listDomainProvisioning,
  listMyDeletionCertificates,
  listStandingGrants,
} from "@xos/data/org-lifecycle";
import { getPartnerOf } from "@xos/data/partner";
import { untyped } from "@xos/data/untyped";
import { getTranslations } from "next-intl/server";
import { InlineAlert } from "@/components/ui";
import {
  CancelOwnershipForm,
  DeleteOrganizationForm,
  DomainCheckForm,
  EndStandingGrantForm,
  LeavePartnerForm,
  OfferOwnershipForm,
  RecoverOrganizationForm,
  StandingGrantForm,
} from "@/components/lifecycle/forms";
import { getFormatters } from "@/lib/platform/format";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A79's settings panels (ADR 0021 item 7; Section 4.6.1, Section 12, Section 14.7):
 *   Settings, Danger zone   delete the org with a 7-day recovery window, transfer ownership, leave the partner
 *   Settings, Security      standing partner grants of a client org
 *   Settings, White label   where each custom domain stands at Vercel or Resend, with the DNS records to publish
 *   Personal, Account       the viewer's deletion certificates
 * Each panel reads with the viewer's client, so row level security decides what appears; the RPCs decide
 * every change.
 */

type T = (key: string, values?: Record<string, string | number>) => string;

async function lifecycleT(): Promise<T> {
  return (await getTranslations("orgLifecycle")) as unknown as T;
}

function Heading({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <header className="flex flex-col gap-4">
      <h2 id={id} className="m-0 text-heading-16 font-semibold">
        {title}
      </h2>
      <p className="m-0 text-text-secondary">{description}</p>
    </header>
  );
}

/** Read scopes a standing grant offers, each a read capability support sessions may grant (1354). */
export const STANDING_GRANT_SCOPES = [
  "org.settings.read",
  "org.members.read",
  "org.usage.read",
  "projects.project.read",
  "work.record.read",
  "schedule.timeline.read",
  "finance.budget.read",
  "reports.report.read",
] as const;

const scopeKey = (code: string) => `partner.scopes.${code.replaceAll(".", "_")}`;

async function partnerName(ctx: SettingsPanelProps["ctx"], partnerId: string, t: T) {
  const { data } = await untyped(ctx.viewer.db)
    .from("organizations")
    .select("name")
    .eq("id", partnerId)
    .limit(1);
  const name = (data as { name?: unknown }[] | null)?.[0]?.name;
  return typeof name === "string" && name.length > 0 ? name : t("partner.yourPartner");
}

// Danger zone ----------------------------------------------------------------------------------------------------

async function DeletionPanel({ ctx }: SettingsPanelProps) {
  const t = await lifecycleT();
  const { date } = await getFormatters(ctx);
  const request = await getDeletionRequest(ctx.viewer.db, ctx.org.id);
  const owner = ctx.capabilities.has("org.organization.delete");
  return (
    <section aria-labelledby="org-delete" className="flex flex-col gap-12">
      <Heading
        id="org-delete"
        title={t("deletion.title")}
        description={t("deletion.description")}
      />
      {!request.ok ? (
        <InlineAlert tone="danger">{t("errors.unexpected")}</InlineAlert>
      ) : request.data ? (
        <div className="flex flex-col gap-12">
          <InlineAlert tone="danger" title={t("deletion.pending")}>
            {t("deletion.pendingBody", { date: date(request.data.recoverUntil) })}
          </InlineAlert>
          {owner ? <RecoverOrganizationForm org={ctx.org.slug} /> : null}
        </div>
      ) : owner ? (
        <DeleteOrganizationForm org={ctx.org.slug} name={ctx.org.name} />
      ) : (
        <p className="m-0 text-text-13 text-text-secondary">{t("deletion.ownerOnly")}</p>
      )}
    </section>
  );
}

async function TransferPanel({ ctx }: SettingsPanelProps) {
  const t = await lifecycleT();
  const { date } = await getFormatters(ctx);
  const owner = ctx.capabilities.has("org.ownership.transfer");
  if (!owner) {
    return (
      <section aria-labelledby="org-transfer" className="flex flex-col gap-12">
        <Heading
          id="org-transfer"
          title={t("transfer.title")}
          description={t("transfer.description")}
        />
        <p className="m-0 text-text-13 text-text-secondary">{t("transfer.ownerOnly")}</p>
      </section>
    );
  }
  const [open, members] = await Promise.all([
    getOpenOwnershipTransfer(ctx.viewer.db, ctx.org.id),
    listMembers(ctx.viewer.db, ctx.org.id),
  ]);
  const me = ctx.viewer.person?.id ?? null;
  const candidates = members.ok
    ? members.data
        .filter((m) => m.personId !== me && !m.roles.some((r) => r.system && r.code === "owner"))
        .map((m) => ({ value: m.personId, label: m.fullName ?? m.personId }))
    : [];
  const offeredTo =
    open.ok && open.data && members.ok
      ? (members.data.find((m) => m.personId === open.data?.toPersonId)?.fullName ?? "")
      : "";
  return (
    <section aria-labelledby="org-transfer" className="flex flex-col gap-12">
      <Heading
        id="org-transfer"
        title={t("transfer.title")}
        description={t("transfer.description")}
      />
      {!open.ok || !members.ok ? (
        <InlineAlert tone="danger">{t("errors.unexpected")}</InlineAlert>
      ) : open.data ? (
        <div className="flex flex-col gap-12">
          <p className="m-0 text-text-13" data-testid="ownership-offer-open">
            {t("transfer.open", { name: offeredTo, date: date(open.data.expiresAt) })}
          </p>
          <CancelOwnershipForm org={ctx.org.slug} transfer={open.data.id} />
        </div>
      ) : candidates.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("transfer.noMembers")}</p>
      ) : (
        <OfferOwnershipForm org={ctx.org.slug} members={candidates} />
      )}
    </section>
  );
}

async function LeavePartnerPanel({ ctx }: SettingsPanelProps) {
  const partner = await getPartnerOf(ctx.viewer.db, ctx.org.id);
  if (!partner.ok || partner.data === null) return null;
  const t = await lifecycleT();
  const [name, subscription] = await Promise.all([
    partnerName(ctx, partner.data, t),
    getSubscription(ctx.viewer.db, ctx.org.id),
  ]);
  const shell = (await getTranslations("shell")) as unknown as T;
  const plan = shell(`plans.${subscription.ok ? subscription.data.planCode : "access"}.name`);
  return (
    <section aria-labelledby="org-leave-partner" className="flex flex-col gap-12">
      <Heading
        id="org-leave-partner"
        title={t("partner.leaveTitle", { partner: name })}
        description={t("partner.leaveDescription", { org: ctx.org.name, partner: name, plan })}
      />
      {ctx.capabilities.has("org.billing.manage") ? (
        <LeavePartnerForm org={ctx.org.slug} name={ctx.org.name} partner={name} />
      ) : (
        <p className="m-0 text-text-13 text-text-secondary">{t("partner.ownerOnly")}</p>
      )}
    </section>
  );
}

// Security ---------------------------------------------------------------------------------------------------

async function StandingGrantsPanel({ ctx }: SettingsPanelProps) {
  const partner = await getPartnerOf(ctx.viewer.db, ctx.org.id);
  if (!partner.ok || partner.data === null) return null;
  const t = await lifecycleT();
  const { date } = await getFormatters(ctx);
  const [name, grants] = await Promise.all([
    partnerName(ctx, partner.data, t),
    listStandingGrants(ctx.viewer.db, ctx.org.id),
  ]);
  const owner = ctx.capabilities.has("org.support_session.grant");
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const scopeLabel = (code: string) =>
    (STANDING_GRANT_SCOPES as readonly string[]).includes(code) ? t(scopeKey(code)) : code;
  return (
    <section aria-labelledby="standing-grants" className="flex flex-col gap-12">
      <Heading
        id="standing-grants"
        title={t("partner.grantsTitle")}
        description={t("partner.grantsDescription", { partner: name })}
      />
      {!grants.ok ? (
        <InlineAlert tone="danger">{t("errors.unexpected")}</InlineAlert>
      ) : grants.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("partner.grantsNone")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-8 p-0" aria-label={t("partner.grantList")}>
          {grants.data.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-8 text-text-13">
              <span>
                {t("partner.grantRow", {
                  scope: scopeLabel(g.capabilityCode),
                  date: date(g.validTo),
                  reference: g.agreementReference,
                })}
              </span>
              {g.open && owner ? (
                <EndStandingGrantForm org={ctx.org.slug} grant={g.id} />
              ) : !g.open ? (
                <span className="text-text-secondary">{t("partner.grantEnded")}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {owner ? (
        <StandingGrantForm
          org={ctx.org.slug}
          scopes={STANDING_GRANT_SCOPES.map((code) => ({ value: code, label: t(scopeKey(code)) }))}
          defaultUntil={iso(new Date(today.getTime() + 90 * 86_400_000))}
          maxUntil={iso(new Date(today.getTime() + 365 * 86_400_000))}
        />
      ) : null}
    </section>
  );
}

// White label ---------------------------------------------------------------------------------------------------

async function DomainSetupPanel({ ctx }: SettingsPanelProps) {
  const t = await lifecycleT();
  const domains = await listDomainProvisioning(ctx.viewer.db, ctx.org.id);
  const writer = ctx.capabilities.has("org.white_label.write");
  return (
    <section aria-labelledby="domain-setup" className="flex flex-col gap-12">
      <Heading
        id="domain-setup"
        title={t("domains.title")}
        description={t("domains.description")}
      />
      {!domains.ok ? (
        <InlineAlert tone="danger">{t("errors.unexpected")}</InlineAlert>
      ) : domains.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("domains.none")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-16 p-0">
          {domains.data.map((d) => (
            <li
              key={d.id}
              className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
            >
              <div className="flex flex-wrap items-center gap-8">
                <span className="font-mono text-text-13">{d.hostname}</span>
                <span className="text-text-12 text-text-secondary">
                  {t(`domains.status.${d.provisioningStatus}`)}
                  {d.purpose === "Email Sending" ? null : (
                    <> · {d.tlsReady ? t("domains.tls") : t("domains.tlsPending")}</>
                  )}
                </span>
                {writer && d.provisioningStatus !== "Active" ? (
                  <DomainCheckForm org={ctx.org.slug} domain={d.id} />
                ) : null}
              </div>
              {d.provisioningError ? (
                <InlineAlert tone="warning">
                  {t("domains.error", { reason: d.provisioningError })}
                </InlineAlert>
              ) : null}
              {d.dnsRecords.length > 0 && d.provisioningStatus !== "Active" ? (
                <table className="w-full table-fixed border-collapse text-start text-text-12">
                  <caption className="mb-4 text-start text-text-12 font-medium">
                    {t("domains.records", { host: d.hostname })}
                  </caption>
                  <thead>
                    <tr className="text-text-secondary">
                      <th scope="col" className="w-64 text-start font-medium">
                        {t("domains.type")}
                      </th>
                      <th scope="col" className="text-start font-medium">
                        {t("domains.name")}
                      </th>
                      <th scope="col" className="text-start font-medium">
                        {t("domains.value")}
                      </th>
                      <th scope="col" className="w-96 text-start font-medium">
                        {t("domains.purpose")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.dnsRecords.map((r) => (
                      <tr key={`${r.type}-${r.name}-${r.value}`} className="align-top">
                        <td className="font-mono">{r.type}</td>
                        <td className="break-all font-mono">{r.name}</td>
                        <td className="break-all font-mono">{r.value}</td>
                        <td>{r.purpose ? t(`domains.purposes.${r.purpose}`) : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Personal: deletion certificates ------------------------------------------------------------------------------------

async function DeletionCertificatesPanel({ ctx }: SettingsPanelProps) {
  const certificates = await listMyDeletionCertificates(ctx.viewer.db);
  if (!certificates.ok || certificates.data.length === 0) return null;
  const t = await lifecycleT();
  const { date, number } = await getFormatters(ctx);
  return (
    <section aria-labelledby="deletion-certificates" className="flex flex-col gap-12">
      <Heading
        id="deletion-certificates"
        title={t("certificates.title")}
        description={t("certificates.description")}
      />
      <ul className="m-0 flex list-none flex-col gap-8 p-0">
        {certificates.data.map((c) => (
          <li key={c.id} className="flex flex-col gap-4 text-text-13">
            {c.issuedAt && c.purgedAt ? (
              <>
                <span>
                  {t("certificates.row", {
                    org: c.orgName,
                    date: date(c.purgedAt),
                    rows: number(c.rowsPurged ?? 0),
                    files: number(c.storageObjectsDeleted),
                  })}
                </span>
                <a
                  href={`/${ctx.org.slug}/deletion-certificates/${c.id}`}
                  download
                  className="w-fit font-medium text-accent-text underline"
                >
                  {t("certificates.download", { org: c.orgName })}
                </a>
              </>
            ) : (
              <span className="text-text-secondary">
                {t("certificates.preparing", { org: c.orgName, date: date(c.purgedAt ?? c.dueAt) })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.danger-zone", order: 20, Panel: DeletionPanel },
  { node: "settings.danger-zone", order: 30, Panel: TransferPanel },
  { node: "settings.danger-zone", order: 40, Panel: LeavePartnerPanel },
  { node: "settings.security", order: 45, Panel: StandingGrantsPanel },
  { node: "settings.white-label", order: 25, Panel: DomainSetupPanel },
  { node: "me.account", order: 110, Panel: DeletionCertificatesPanel },
];
