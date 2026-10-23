import { listMyOrganizations, listRoleCapabilities } from "@xos/data";
import {
  getAccountNotificationDefaults,
  listOfferedCapabilities,
  listServiceRegions,
} from "@xos/data/company-settings";
import { listMyConnectedApps } from "@xos/data/connected-apps";
import {
  capabilityGroupsOf,
  listOrgsAllowingPersonalTokens,
  listPersonalTokens,
} from "@xos/data/developer";
import { listAccountMembers } from "@xos/data/gateway";
import { PARTY_CATEGORIES, PARTY_CHANNELS } from "@xos/data/party-notifications";
import { listJurisdictions } from "@xos/data/places";
import type { ReactNode } from "react";
import { ActionButton } from "@/components/actions/action-button";
import { RowList } from "@/components/engagement/rows";
import { SimpleForm } from "@/components/forms/simple-form";
import { RegionError, Section } from "@/components/page/page";
import { leaveAccountAction } from "@/lib/actions/profile";
import {
  addCapabilityAction,
  addServiceRegionAction,
  createPersonalTokenAction,
  makeOwnerAction,
  removeCapabilityAction,
  removeRegionAction,
  revokeConnectedAppAction,
  revokePersonalTokenAction,
  saveCompanyDefaultsAction,
  stepDownAction,
} from "@/lib/actions/surfaces";
import { formatDate } from "@/lib/format";
import type { GatewayContext } from "@/lib/shell/context";
import { enumLabelKey, type Translate } from "@/lib/shell/translate";
import { ChoicesForm, TokenForm } from "./surface-forms";

/**
 * Gateway settings sections A86 fills (RRR-131, finding A65-004), each over the backend it had or the small model
 * A86 added:
 *   Connected Apps                       the person's OAuth grants with revoke (personal item 13, 0638, 1433)
 *   Developer                            the person's personal API tokens in every org, and a form per org that
 *                                        allows them (personal item 15, 1432)
 *   Company, Service Regions and Capabilities   the company profile's regions and offered categories (item 3, 0860)
 *   Company, Notifications Defaults      what team members receive until they choose (item 7, 1434)
 *   Company, Danger Zone                 handing ownership over, stepping down and leaving (item 8, 0710)
 */

const P = "settingsSurfaces";

export interface SurfaceProps {
  readonly ctx: GatewayContext;
  readonly t: Translate;
  readonly locale: string;
  /** The section's header, drawn by sections.tsx. */
  readonly header: ReactNode;
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="m-0 text-text-13 text-text-secondary">{children}</p>;
}

/** Whether a token's expiry has passed, read when the page renders. */
function hasExpired(iso: string): boolean {
  return Date.parse(iso) <= Date.now();
}

// Connected apps ----------------------------------------------------------------------------------------------

export async function ConnectedAppsSurface({ ctx, t, locale, header }: SurfaceProps) {
  const apps = await listMyConnectedApps(ctx.db);
  return (
    <>
      {header}
      {!apps.ok ? (
        <RegionError />
      ) : apps.data.length === 0 ? (
        <Quiet>{t(`${P}.connectedApps.none`)}</Quiet>
      ) : (
        <RowList
          label={t(`${P}.connectedApps.title`)}
          items={apps.data.map((a) => ({
            id: a.grantId,
            title: a.appName,
            meta: [
              t(`${P}.connectedApps.registeredBy`, { org: a.orgName }),
              t(`${P}.scopesList`, { scopes: a.scopes.join(", ") }),
              t(`${P}.connectedApps.granted`, { date: formatDate(locale, a.grantedAt) }),
            ],
            action: (
              <ActionButton
                action={revokeConnectedAppAction.bind(null, a.grantId)}
                label={t(`${P}.gateway.disconnect`)}
                variant="ghost"
              />
            ),
          }))}
        />
      )}
      <Quiet>{t(`${P}.connectedApps.description`)}</Quiet>
    </>
  );
}

// Developer ---------------------------------------------------------------------------------------------------

export async function DeveloperSurface({ ctx, t, locale, header }: SurfaceProps) {
  const [tokens, allowing, orgs] = await Promise.all([
    listPersonalTokens(ctx.db, { personId: ctx.personId }),
    listOrgsAllowingPersonalTokens(ctx.db),
    listMyOrganizations(ctx.db, ctx.personId),
  ]);
  if (!tokens.ok || !allowing.ok || !orgs.ok) return <RegionError />;
  const forms = await Promise.all(
    allowing.data.map(async (org) => {
      const roles = orgs.data.find((o) => o.id === org.id)?.roles.map((r) => r.id) ?? [];
      const held = await listRoleCapabilities(ctx.db, roles);
      return { org, groups: held.ok ? capabilityGroupsOf(held.data.keys()) : [] };
    }),
  );
  const expiry = ["30", "90", "180", "365"].map((d) => ({
    value: d,
    label: t(`${P}.expiry.days`, { count: Number(d) }),
  }));
  return (
    <>
      {header}
      <Section title={t(`${P}.tokens.title`)}>
        {tokens.data.length === 0 ? (
          <Quiet>{t(`${P}.gateway.noTokens`)}</Quiet>
        ) : (
          <RowList
            label={t(`${P}.tokens.title`)}
            items={tokens.data.map((tok) => ({
              id: tok.id,
              title: tok.name,
              tag: tok.revokedAt
                ? { label: t(`${P}.revoked`), tone: "danger" as const }
                : hasExpired(tok.expiresAt)
                  ? { label: t(`${P}.expired`), tone: "warning" as const }
                  : { label: t(`${P}.active`), tone: "success" as const },
              meta: [
                tok.orgName,
                `${tok.prefix}…`,
                t(`${P}.scopesList`, { scopes: tok.scopes.join(", ") }),
                t(`${P}.expiry.until`, { date: formatDate(locale, tok.expiresAt) }),
                tok.lastUsedAt
                  ? t(`${P}.lastUsed`, { date: formatDate(locale, tok.lastUsedAt) })
                  : t(`${P}.neverUsed`),
              ],
              ...(tok.revokedAt
                ? {}
                : {
                    action: (
                      <ActionButton
                        action={revokePersonalTokenAction.bind(null, tok.id)}
                        label={t(`${P}.revoke`)}
                        variant="ghost"
                      />
                    ),
                  }),
            }))}
          />
        )}
      </Section>
      {forms.length === 0 ? (
        <Quiet>{t(`${P}.gateway.tokensOff`)}</Quiet>
      ) : (
        forms.map(({ org, groups }) => (
          <Section key={org.id} title={t(`${P}.gateway.tokenFor`, { org: org.name })}>
            <TokenForm
              action={createPersonalTokenAction}
              orgId={org.id}
              scopes={groups}
              expiry={expiry}
              copy={{
                label: t(`${P}.gateway.tokenFor`, { org: org.name }),
                name: t(`${P}.fields.name`),
                scopes: t(`${P}.fields.scopes`),
                scopesHelp: t(`${P}.tokens.scopesHelp`),
                expires: t(`${P}.fields.expires`),
                submit: t(`${P}.tokens.addSubmit`),
                secretTitle: t(`${P}.secret.token.title`),
                secretBody: t(`${P}.secret.token.body`),
                secretField: t(`${P}.secret.token.field`),
                copy: t(`${P}.secret.copy`),
                copied: t(`${P}.secret.copied`),
              }}
            />
          </Section>
        ))
      )}
    </>
  );
}

// Company: service regions and capabilities -------------------------------------------------------------------

export async function RegionsSurface({ ctx, t, header }: SurfaceProps) {
  if (!ctx.acting) return null;
  const accountId = ctx.acting.id;
  const [regions, capabilities, jurisdictions, categories] = await Promise.all([
    listServiceRegions(ctx.db, accountId),
    listOfferedCapabilities(ctx.db, accountId),
    listJurisdictions(ctx.db),
    ctx.db.schema("xpms").from("dim_category").select("cat_urid, category").order("cat_urid"),
  ]);
  if (!regions.ok || !capabilities.ok || !jurisdictions.ok) return <RegionError />;
  const admin = ctx.acting.roles.some((r) => r === "Account Owner" || r === "Account Admin");
  const usedRegions = new Set(regions.data.map((r) => r.jurisdictionId));
  const usedCategories = new Set(capabilities.data.map((c) => c.categoryUrid));
  return (
    <>
      {header}
      <Section title={t(`${P}.gateway.regions`)}>
        <Quiet>{t(`${P}.gateway.regionsHelp`)}</Quiet>
        {regions.data.length === 0 ? (
          <Quiet>{t(`${P}.gateway.noRegions`)}</Quiet>
        ) : (
          <RowList
            label={t(`${P}.gateway.regions`)}
            items={regions.data.map((r) => ({
              id: r.id,
              title: r.jurisdictionId,
              ...(admin
                ? {
                    action: (
                      <ActionButton
                        action={removeRegionAction.bind(null, r.id)}
                        label={t(`${P}.remove`)}
                        variant="ghost"
                      />
                    ),
                  }
                : {}),
            }))}
          />
        )}
        {admin ? (
          <SimpleForm
            id="company-region"
            action={addServiceRegionAction}
            label={t(`${P}.gateway.addRegion`)}
            errorsNamespace="gateway.settings.surfaces.errors"
            submitLabel={t(`${P}.gateway.addRegion`)}
            doneLabel={t(`${P}.gateway.added`)}
            resetOnDone
            variant="secondary"
            fields={[
              {
                name: "jurisdictionId",
                label: t(`${P}.gateway.jurisdiction`),
                kind: "select",
                options: jurisdictions.data
                  .filter((j) => !usedRegions.has(j.id))
                  .map((j) => ({ value: j.id, label: j.id })),
              },
            ]}
          />
        ) : null}
      </Section>
      <Section title={t(`${P}.gateway.capabilities`)}>
        <Quiet>{t(`${P}.gateway.capabilitiesHelp`)}</Quiet>
        {capabilities.data.length === 0 ? (
          <Quiet>{t(`${P}.gateway.noCapabilities`)}</Quiet>
        ) : (
          <RowList
            label={t(`${P}.gateway.capabilities`)}
            items={capabilities.data.map((c) => ({
              id: c.id,
              title: c.categoryName ?? c.categoryUrid,
              meta: [c.categoryUrid],
              ...(admin
                ? {
                    action: (
                      <ActionButton
                        action={removeCapabilityAction.bind(null, c.id)}
                        label={t(`${P}.remove`)}
                        variant="ghost"
                      />
                    ),
                  }
                : {}),
            }))}
          />
        )}
        {admin ? (
          <SimpleForm
            id="company-capability"
            action={addCapabilityAction}
            label={t(`${P}.gateway.addCapability`)}
            errorsNamespace="gateway.settings.surfaces.errors"
            submitLabel={t(`${P}.gateway.addCapability`)}
            doneLabel={t(`${P}.gateway.added`)}
            resetOnDone
            variant="secondary"
            fields={[
              {
                name: "categoryUrid",
                label: t(`${P}.gateway.category`),
                kind: "select",
                options: (categories.data ?? [])
                  .filter((c) => !usedCategories.has(c.cat_urid))
                  .map((c) => ({ value: c.cat_urid, label: `${c.category} · ${c.cat_urid}` })),
              },
            ]}
          />
        ) : null}
      </Section>
    </>
  );
}

// Company: notification defaults ------------------------------------------------------------------------------

export async function CompanyNotificationsSurface({ ctx, t, header }: SurfaceProps) {
  if (!ctx.acting) return null;
  const defaults = await getAccountNotificationDefaults(ctx.db, ctx.acting.id);
  if (!defaults.ok) return <RegionError />;
  const admin = ctx.acting.roles.some((r) => r === "Account Owner" || r === "Account Admin");
  return (
    <>
      {header}
      {PARTY_CATEGORIES.map((category) => (
        <ChoicesForm
          key={category}
          action={saveCompanyDefaultsAction}
          hidden={{}}
          legend={t(`gateway.settings.notifications.categories.${category}.label`)}
          help={t(`${P}.gateway.defaultsHelp`)}
          canEdit={admin}
          submit={t(`${P}.gateway.saveDefaults`)}
          saved={t(`${P}.gateway.defaultsSaved`)}
          rows={PARTY_CHANNELS.map((channel) => ({
            name: `${category}.${channel}`,
            label: t(`gateway.settings.notifications.channels.${channel}`),
            checked:
              defaults.data.find((d) => d.category === category && d.channel === channel)
                ?.enabled ?? true,
          }))}
        />
      ))}
      <Quiet>{t(admin ? `${P}.gateway.defaultsOwn` : `${P}.gateway.defaultsReadOnly`)}</Quiet>
    </>
  );
}

// Company: danger zone ----------------------------------------------------------------------------------------

export async function CompanyDangerSurface({ ctx, t, locale, header }: SurfaceProps) {
  if (!ctx.acting) return null;
  const members = await listAccountMembers(ctx.db, ctx.acting.id);
  if (!members.ok) return <RegionError />;
  const me = members.data.find((m) => m.personId === ctx.personId);
  const owners = members.data.filter((m) => m.roles.includes("Account Owner"));
  const iOwn = me?.roles.includes("Account Owner") ?? false;
  const others = members.data.filter(
    (m) => m.personId !== ctx.personId && !m.roles.includes("Account Owner"),
  );
  return (
    <>
      {header}
      <Section title={t(`${P}.gateway.owners`)}>
        <RowList
          label={t(`${P}.gateway.owners`)}
          items={owners.map((m) => ({
            id: m.membershipId,
            title: m.fullName ?? t(`${P}.someone`),
            meta: [
              m.roles.map((r) => t(enumLabelKey("accountRole", r))).join(", "),
              t("gateway.profile.company.since", { date: formatDate(locale, m.validFrom) }),
            ],
          }))}
        />
        {iOwn && others.length > 0 ? (
          <SimpleForm
            id="company-make-owner"
            action={makeOwnerAction}
            label={t(`${P}.gateway.makeOwner`)}
            errorsNamespace="gateway.settings.surfaces.errors"
            submitLabel={t(`${P}.gateway.makeOwner`)}
            doneLabel={t(`${P}.gateway.madeOwner`)}
            resetOnDone
            variant="secondary"
            fields={[
              {
                name: "personId",
                label: t(`${P}.gateway.member`),
                kind: "select",
                options: others.map((m) => ({
                  value: m.personId,
                  label: m.fullName ?? m.personId,
                })),
                help: t(`${P}.gateway.makeOwnerHelp`),
              },
            ]}
          />
        ) : null}
        {iOwn && me && owners.length > 1 ? (
          <ActionButton
            action={stepDownAction.bind(null, me.membershipId)}
            label={t(`${P}.gateway.stepDown`)}
            variant="secondary"
          />
        ) : null}
        {iOwn && owners.length === 1 ? <Quiet>{t(`${P}.gateway.lastOwner`)}</Quiet> : null}
      </Section>
      <Section title={t(`${P}.gateway.leaveTitle`)}>
        <Quiet>{t(`${P}.gateway.leaveBody`)}</Quiet>
        {me && !(iOwn && owners.length === 1) ? (
          <ActionButton
            action={leaveAccountAction.bind(null, me.membershipId)}
            label={t(`${P}.gateway.leave`, { name: ctx.acting.name })}
            variant="danger"
          />
        ) : null}
      </Section>
      <Section title={t(`${P}.gateway.closeTitle`)}>
        <Quiet>{t("gateway.settings.notes.dangerZone")}</Quiet>
      </Section>
    </>
  );
}
