import { getSubscription, listMembers } from "@xos/data";
import { legalEntityDefaults, reviewRemovesUnreviewed } from "@/lib/shell/org-settings";
import {
  breakGlassOpen,
  listAccessReviewCampaigns,
  listAccessReviewItems,
  listAllowedNetworks,
  listBreakGlassSessions,
  listLegalEntities,
  listMyBlocks,
  networkAccess,
} from "@xos/data/access-controls";
import { listSettingValues } from "@xos/data/settings";
import { getLocale } from "next-intl/server";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import {
  AddLegalEntityForm,
  AddNetworkForm,
  BlockForm,
  BreakGlassForm,
  CancelReviewButton,
  EndBreakGlassButton,
  LegalEntityActions,
  OpenReviewForm,
  RemoveNetworkButton,
  ReviewDecision,
  UnblockButton,
} from "@/components/settings/access-control-forms";
import { InlineAlert } from "@/components/ui";
import { clientIp } from "@/lib/auth/legal";
import { planHasFeature } from "@/lib/settings/plan";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A52's settings panels (RRR-97, ADR 0032 amendment): legal entities on Legal Entities and Fiscal,
 * the IP allow-list and break-glass on Security, access review campaigns on Access Reviews, and
 * blocked people and organizations on Profile Privacy. Each reads with the viewer's client, so row
 * level security decides what appears; the forms post to access-control-actions.ts.
 */

const P = "settings.accessControls";

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex max-w-layout-form flex-col gap-12">
      <header className="flex flex-col gap-4">
        <h2 id={id} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">{description}</p>
      </header>
      {children}
    </section>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="m-0 text-text-13 text-text-secondary">{children}</p>;
}

function Chip({ children, tone }: { children: string; tone: "success" | "warning" | "neutral" }) {
  const color =
    tone === "success"
      ? "text-success-text"
      : tone === "warning"
        ? "text-warning-text"
        : "text-text-secondary";
  return (
    <span
      className={`inline-flex rounded-chip border border-border-subtle px-8 py-2 text-text-12 font-medium ${color}`}
    >
      {children}
    </span>
  );
}

function loadFailed(t: Translate) {
  return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
}

// Legal entities ---------------------------------------------------------------------------------------------

async function LegalEntitiesPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const [entities, settings, currencies, locale] = await Promise.all([
    listLegalEntities(ctx.viewer.db, ctx.org.id),
    listSettingValues(ctx.viewer.db, ctx.org.id),
    ctx.viewer.db.from("currencies").select("currency_code").order("currency_code"),
    getLocale(),
  ]);
  if (!entities.ok || !settings.ok || currencies.error) return loadFailed(t);
  const canEdit = ctx.capabilities.has("org.legal_entities.write");
  const monthName = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
  const months = Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1),
    label: monthName.format(new Date(Date.UTC(2026, i, 1))),
  }));
  const { month: defaultMonth, currency: defaultCurrency } = legalEntityDefaults(
    (key) => settings.data.find((v) => v.key === key && v.scopeKind === "Organization")?.value,
  );
  return (
    <Section
      id="legal-entities"
      title={t(`${P}.legalEntities.title`)}
      description={t(`${P}.legalEntities.description`)}
    >
      {entities.data.length === 0 ? (
        <Empty>{t(`${P}.legalEntities.none`)}</Empty>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {entities.data.map((e) => (
            <li key={e.id} className="flex flex-wrap items-start justify-between gap-12 py-12">
              <div className="flex min-w-0 flex-col gap-4">
                <span className="flex flex-wrap items-center gap-8 text-label-13 font-medium">
                  {e.legalName}
                  {e.isPrimary ? (
                    <Chip tone="success">{t(`${P}.legalEntities.primary`)}</Chip>
                  ) : null}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {t(`${P}.legalEntities.summary`, {
                    country: e.countryCode,
                    month: months[e.fiscalYearStartMonth - 1]?.label ?? "",
                    currency: e.baseCurrency,
                  })}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {e.taxIdentifier !== null
                    ? t(`${P}.legalEntities.taxShown`, { value: e.taxIdentifier })
                    : e.taxIdentifierLast4 !== null
                      ? t(`${P}.legalEntities.taxMasked`, { last4: e.taxIdentifierLast4 })
                      : t(`${P}.legalEntities.taxNone`)}
                </span>
              </div>
              {canEdit ? (
                <LegalEntityActions
                  org={ctx.org.slug}
                  id={e.id}
                  name={e.legalName}
                  isPrimary={e.isPrimary}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <AddLegalEntityForm
          org={ctx.org.slug}
          months={months}
          currencies={currencies.data.flatMap((c) =>
            c.currency_code ? [{ value: c.currency_code, label: c.currency_code }] : [],
          )}
          defaultMonth={defaultMonth}
          defaultCurrency={defaultCurrency}
        />
      ) : null}
    </Section>
  );
}

// IP allow-list ------------------------------------------------------------------------------------------------

async function IpAllowlistPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const ip = clientIp(await headers());
  const [networks, access, subscription] = await Promise.all([
    listAllowedNetworks(ctx.viewer.db, ctx.org.id),
    networkAccess(ctx.viewer.db, ctx.org.id, ip),
    getSubscription(ctx.viewer.db, ctx.org.id),
  ]);
  if (!networks.ok || !access.ok || !subscription.ok) return loadFailed(t);
  const canEdit = ctx.capabilities.has("org.security.write");
  const inPlan = planHasFeature(subscription.data.planCode, "ip_allowlist");
  return (
    <Section
      id="ip-allowlist"
      title={t(`${P}.network.title`)}
      description={t(`${P}.network.description`)}
    >
      {!inPlan ? <InlineAlert tone="info">{t(`${P}.network.notInPlan`)}</InlineAlert> : null}
      <p role="status" className="m-0 text-text-13">
        {access.data.enforced ? t(`${P}.network.enforced`) : t(`${P}.network.notEnforced`)}{" "}
        {ip === null
          ? t(`${P}.network.addressUnknown`)
          : access.data.covered
            ? t(`${P}.network.addressCovered`, { ip })
            : t(`${P}.network.addressOutside`, { ip })}
      </p>
      {networks.data.length === 0 ? (
        <Empty>{t(`${P}.network.none`)}</Empty>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {networks.data.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center justify-between gap-12 py-8">
              <div className="flex min-w-0 flex-col gap-2">
                <span className="font-mono text-label-13 font-medium break-all">{n.cidr}</span>
                <span className="text-text-12 text-text-secondary">{n.label}</span>
              </div>
              {canEdit ? (
                <RemoveNetworkButton org={ctx.org.slug} id={n.id} label={n.label} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit && inPlan ? <AddNetworkForm org={ctx.org.slug} /> : null}
    </Section>
  );
}

// Break-glass ----------------------------------------------------------------------------------------------------

async function BreakGlassPanel({ ctx }: SettingsPanelProps) {
  const canUse = ctx.capabilities.has("org.break_glass.use");
  const canAudit = ctx.capabilities.has("audit.log.read");
  if (!canUse && !canAudit) return null;
  const t = await getTranslate();
  const [sessions, members, locale] = await Promise.all([
    listBreakGlassSessions(ctx.viewer.db, ctx.org.id),
    listMembers(ctx.viewer.db, ctx.org.id),
    getLocale(),
  ]);
  if (!sessions.ok || !members.ok) return loadFailed(t);
  const me = ctx.viewer.person?.id;
  const names = new Map(members.data.map((m) => [m.personId, m.fullName ?? ""]));
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const mine = sessions.data.find((s) => s.personId === me && breakGlassOpen(s));
  return (
    <Section
      id="break-glass"
      title={t(`${P}.breakGlass.title`)}
      description={t(`${P}.breakGlass.description`)}
    >
      {mine ? (
        <div className="flex flex-wrap items-center justify-between gap-12">
          <InlineAlert tone="warning">
            {t(`${P}.breakGlass.open`, { until: when.format(new Date(mine.expiresAt)) })}
          </InlineAlert>
          <EndBreakGlassButton org={ctx.org.slug} sessionId={mine.id} />
        </div>
      ) : canUse ? (
        <BreakGlassForm org={ctx.org.slug} />
      ) : null}
      {canAudit ? (
        sessions.data.length === 0 ? (
          <Empty>{t(`${P}.breakGlass.none`)}</Empty>
        ) : (
          <ul
            aria-label={t(`${P}.breakGlass.history`)}
            className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
          >
            {sessions.data.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 py-8">
                <span className="text-label-13 font-medium">
                  {t(`${P}.breakGlass.entry`, {
                    name: names.get(s.personId) || t(`${P}.unknownPerson`),
                    start: when.format(new Date(s.startedAt)),
                  })}
                </span>
                <span className="text-text-12 text-text-secondary">{s.reason}</span>
                <span className="text-text-12 text-text-secondary">
                  {breakGlassOpen(s)
                    ? t(`${P}.breakGlass.stillOpen`)
                    : s.endedAt !== null
                      ? t(`${P}.breakGlass.endedEarly`, { end: when.format(new Date(s.endedAt)) })
                      : t(`${P}.breakGlass.expired`, { end: when.format(new Date(s.expiresAt)) })}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Section>
  );
}

// Access reviews ---------------------------------------------------------------------------------------------------

async function AccessReviewsPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const [campaigns, settings, locale] = await Promise.all([
    listAccessReviewCampaigns(ctx.viewer.db, ctx.org.id),
    listSettingValues(ctx.viewer.db, ctx.org.id),
    getLocale(),
  ]);
  if (!campaigns.ok || !settings.ok) return loadFailed(t);
  const canManage = ctx.capabilities.has("org.access_reviews.manage");
  const active = campaigns.data.find((c) => c.state === "Active");
  const past = campaigns.data.filter((c) => c.state !== "Active");
  const items = active ? await listAccessReviewItems(ctx.viewer.db, active.id) : null;
  if (items && !items.ok) return loadFailed(t);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  const me = ctx.viewer.person?.id;
  const removeUnreviewed = reviewRemovesUnreviewed(
    (key) => settings.data.find((v) => v.key === key && v.scopeKind === "Organization")?.value,
  );
  const today = new Date();
  const due = new Date(today.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
  const quarter = Math.floor(today.getUTCMonth() / 3) + 1;
  const list = items?.ok ? items.data : [];
  const decided = list.filter((i) => i.decision !== null).length;
  const flagged = list.filter((i) => i.decision === null && i.flaggedAt !== null).length;
  const roleLabel = (code: string | null, name: string | null) =>
    name ?? (code ? t(`shell.roles.${code}`) : t(`${P}.reviews.unknownRole`));

  return (
    <Section
      id="access-reviews"
      title={t(`${P}.reviews.title`)}
      description={t(`${P}.reviews.description`)}
    >
      {active ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-12">
            <div className="flex flex-col gap-4">
              <span className="text-label-13 font-medium">{active.name}</span>
              <span className="text-text-12 text-text-secondary">
                {t(`${P}.reviews.progress`, {
                  decided,
                  total: list.length,
                  due: date.format(new Date(`${active.dueOn}T00:00:00Z`)),
                })}
              </span>
              <span className="text-text-12 text-text-secondary">
                {active.autoRemoveUnreviewed
                  ? t(`${P}.reviews.autoRemoveOn`)
                  : t(`${P}.reviews.autoRemoveOff`)}
              </span>
            </div>
            {canManage ? <CancelReviewButton org={ctx.org.slug} campaignId={active.id} /> : null}
          </div>
          {flagged > 0 ? (
            <InlineAlert tone="warning">
              {t(`${P}.reviews.flagged`, { count: flagged })}
            </InlineAlert>
          ) : null}
          <ul
            aria-label={t(`${P}.reviews.itemsLabel`)}
            className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
          >
            {list.map((item) => {
              const person = item.personName ?? t(`${P}.unknownPerson`);
              const role = roleLabel(item.roleCode, item.roleName);
              const subject = t(`${P}.reviews.subject`, { person, role });
              const self = item.personId !== null && item.personId === me;
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-12 py-8"
                >
                  <div className="flex min-w-0 flex-col gap-2">
                    <span className="text-label-13 font-medium">{person}</span>
                    <span className="text-text-12 text-text-secondary">
                      {role}
                      {self ? ` · ${t(`${P}.reviews.self`)}` : ""}
                    </span>
                  </div>
                  {item.decision !== null ? (
                    <Chip tone={item.decision === "Confirmed" ? "success" : "neutral"}>
                      {t(`${P}.reviews.decisions.${item.decision}`)}
                    </Chip>
                  ) : canManage ? (
                    <ReviewDecision
                      org={ctx.org.slug}
                      itemId={item.id}
                      subject={subject}
                      self={self}
                    />
                  ) : item.flaggedAt !== null ? (
                    <Chip tone="warning">{t(`${P}.reviews.unreviewedFlagged`)}</Chip>
                  ) : (
                    <Chip tone="neutral">{t(`${P}.reviews.unreviewed`)}</Chip>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : canManage ? (
        <OpenReviewForm
          org={ctx.org.slug}
          defaultName={t(`${P}.reviews.defaultName`, { quarter, year: today.getUTCFullYear() })}
          defaultDue={due}
          defaultAutoRemove={removeUnreviewed}
        />
      ) : (
        <Empty>{t(`${P}.reviews.noneActive`)}</Empty>
      )}
      {past.length > 0 ? (
        <ul
          aria-label={t(`${P}.reviews.pastLabel`)}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
        >
          {past.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-12 py-8">
              <span className="text-label-13">{c.name}</span>
              <span className="text-text-12 text-text-secondary">
                {t(`${P}.reviews.closed.${c.state}`, {
                  date: date.format(new Date(c.closedAt ?? c.openedAt)),
                })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

// Blocks ------------------------------------------------------------------------------------------------------------

async function BlocksPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const blocks = await listMyBlocks(ctx.viewer.db);
  if (!blocks.ok) return loadFailed(t);
  return (
    <Section id="blocks" title={t(`${P}.blocks.title`)} description={t(`${P}.blocks.description`)}>
      {blocks.data.length === 0 ? (
        <Empty>{t(`${P}.blocks.none`)}</Empty>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {blocks.data.map((b) => {
            const name = b.name ?? t(`${P}.blocks.kinds.${b.kind}`);
            return (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-12 py-8">
                <div className="flex min-w-0 flex-col gap-2">
                  <span className="text-label-13 font-medium">{name}</span>
                  <span className="text-text-12 text-text-secondary">
                    {t(`${P}.blocks.kinds.${b.kind}`)}
                    {b.handle ? ` · ${b.handle}` : ""}
                  </span>
                </div>
                <UnblockButton org={ctx.org.slug} id={b.id} name={name} />
              </li>
            );
          })}
        </ul>
      )}
      <BlockForm org={ctx.org.slug} />
    </Section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.legal-entities-and-fiscal", order: 10, Panel: LegalEntitiesPanel },
  { node: "settings.security", order: 30, Panel: IpAllowlistPanel },
  { node: "settings.security", order: 40, Panel: BreakGlassPanel },
  { node: "settings.access-reviews", order: 10, Panel: AccessReviewsPanel },
  { node: "me.profile-privacy", order: 20, Panel: BlocksPanel },
];
