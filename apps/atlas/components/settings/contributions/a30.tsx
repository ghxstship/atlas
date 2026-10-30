import { getSubscription, listRoles, listWorkspaces } from "@xos/data";
import type { Route } from "next";
import Link from "next/link";
import {
  getOrgBrand,
  listBrandFonts,
  listDisabledModules,
  listOrgDomains,
  listOrgLegalAcceptances,
  listSettingValues,
  type OrgDomain,
} from "@xos/data/settings";
import { myStagedUploadStatus } from "@xos/data/staged-uploads";
import { GeneralForm } from "@/components/settings/forms";
import {
  AcceptLegalForm,
  AddDomainForm,
  BrandAssetForm,
  BrandForm,
  ModulesForm,
  RemoveDomainButton,
} from "@/components/settings/identity-forms";
import {
  AutoJoinPanel,
  JoiningPanel,
  OffboardingPanel,
  OrgProfilePanel,
  PrivacyPanel,
  ProfilePanel,
} from "@/components/settings/profile-panels";
import { referenceOptions } from "@/components/settings/registry-section";
import { SettingsForm } from "@/components/settings/setting-field";
import { InlineAlert } from "@/components/ui";
import { defaultAccent } from "@/lib/brand/contrast";
import { LEGAL_DOCUMENTS } from "@/lib/legal.generated";
import { planHasFeature } from "@/lib/settings/plan";
import { choiceLabelKey, formText, workspaceSettings } from "@/lib/settings/registry";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A30's settings panels: the org name, brand and logos, domains, module switches, verified domains
 * with automatic join, legal acceptances, workspace overrides, teams and roles. Each reads with
 * the viewer's client, so row level security decides what appears.
 */

function Heading({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="m-0 text-heading-16 font-semibold">
      {children}
    </h2>
  );
}

function LoadFailed({ message }: { message: string }) {
  return <InlineAlert tone="danger">{message}</InlineAlert>;
}

async function GeneralNamePanel({ ctx }: SettingsPanelProps) {
  return <GeneralForm org={ctx.org.slug} name={ctx.org.name} />;
}

async function BrandPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const [brand, fonts, subscription] = await Promise.all([
    getOrgBrand(ctx.viewer.db, ctx.org.id),
    listBrandFonts(ctx.viewer.db),
    getSubscription(ctx.viewer.db, ctx.org.id),
  ]);
  if (!brand.ok || !fonts.ok || !subscription.ok) {
    return <LoadFailed message={t("settings.loadFailed")} />;
  }
  const b = brand.data;
  const canEdit = ctx.capabilities.has("org.white_label.write");
  // A new logo waits in upload-staging for its virus scan (1265); its uploader sees whether it is
  // still being checked or was blocked. Null once published, and for everyone else.
  const scans = canEdit
    ? await Promise.all(
        [b.logoLightPath, b.logoDarkPath, b.faviconPath, b.appIconPath].map(async (path) => {
          if (path === null) return null;
          const scan = await myStagedUploadStatus(ctx.viewer.db, "org-brand", path);
          return scan.ok ? scan.data : null;
        }),
      )
    : [null, null, null, null];
  return (
    <>
      <section aria-labelledby="brand-heading" className="flex flex-col gap-12">
        <Heading id="brand-heading">{t("settings.brand.title")}</Heading>
        <BrandForm
          key={JSON.stringify(b)}
          org={ctx.org.slug}
          canEdit={canEdit}
          whiteLabelInPlan={planHasFeature(subscription.data.planCode, "white_label")}
          fonts={fonts.data}
          defaultAccent={defaultAccent()}
          brand={{
            displayName: b.displayName ?? "",
            accentHex: b.accentHex ?? "",
            neutralTintHex: b.neutralTintHex ?? "",
            fontFamily: b.fontFamily ?? "",
            radiusScale: b.radiusScale,
            emailSenderName: b.emailSenderName ?? "",
            supportEmail: b.supportEmail ?? "",
            legalEntityName: b.legalEntityName ?? "",
            suppressPoweredBy: b.suppressPoweredBy,
          }}
        />
      </section>
      {canEdit ? (
        <section
          aria-labelledby="assets-heading"
          className="flex max-w-layout-form flex-col gap-12"
        >
          <Heading id="assets-heading">{t("settings.brand.assets")}</Heading>
          <div className="grid grid-cols-1 gap-12 sm:grid-cols-2">
            <BrandAssetForm
              org={ctx.org.slug}
              slot="logoLight"
              label={t("settings.brand.logoLight")}
              current={b.logoLightPath}
              scan={scans[0] ?? null}
            />
            <BrandAssetForm
              org={ctx.org.slug}
              slot="logoDark"
              label={t("settings.brand.logoDark")}
              current={b.logoDarkPath}
              scan={scans[1] ?? null}
            />
            <BrandAssetForm
              org={ctx.org.slug}
              slot="favicon"
              label={t("settings.brand.favicon")}
              current={b.faviconPath}
              scan={scans[2] ?? null}
            />
            <BrandAssetForm
              org={ctx.org.slug}
              slot="appIcon"
              label={t("settings.brand.appIcon")}
              current={b.appIconPath}
              scan={scans[3] ?? null}
            />
          </div>
        </section>
      ) : null}
    </>
  );
}

async function DomainList({
  ctx,
  domains,
  canEdit,
}: {
  ctx: SettingsPanelProps["ctx"];
  domains: readonly OrgDomain[];
  canEdit: boolean;
}) {
  const t = await getTranslate();
  if (domains.length === 0) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("settings.domains.none")}</p>;
  }
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
      {domains.map((d) => (
        <li key={d.id} className="flex flex-wrap items-start justify-between gap-12 py-12">
          <div className="flex min-w-0 flex-col gap-4">
            <span className="text-label-13 font-medium break-all">{d.hostname}</span>
            <span className="text-text-12 text-text-secondary">
              {t(`settings.domains.purposes.${d.purpose.replace(" ", "")}`)} ·{" "}
              {t(`settings.domains.states.${d.state}`)}
            </span>
            {d.state !== "Verified" ? (
              <span className="text-text-12 text-text-secondary break-all">
                {t("settings.domains.txt", { token: d.verificationToken })}
              </span>
            ) : null}
          </div>
          {canEdit ? (
            <RemoveDomainButton org={ctx.org.slug} domainId={d.id} hostname={d.hostname} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

async function DomainsPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const [domains, subscription] = await Promise.all([
    listOrgDomains(ctx.viewer.db, ctx.org.id),
    getSubscription(ctx.viewer.db, ctx.org.id),
  ]);
  if (!domains.ok || !subscription.ok) return <LoadFailed message={t("settings.loadFailed")} />;
  const canEdit = ctx.capabilities.has("org.white_label.write");
  const plan = subscription.data.planCode;
  const purposes = [
    // The custom-domain purposes of org_domain_purpose that the 0850 and 1355 triggers gate on
    // custom_domain; they equal app.shortcut_shell's values by coincidence, not that enum.
    // eslint-disable-next-line xos/no-restated-enums
    ...(planHasFeature(plan, "custom_domain") ? (["Atlas", "Gateway"] as const) : []),
    ...(planHasFeature(plan, "white_label") ? (["Email Sending"] as const) : []),
  ];
  return (
    <section aria-labelledby="domains-heading" className="flex max-w-layout-form flex-col gap-12">
      <Heading id="domains-heading">{t("settings.domains.title")}</Heading>
      <DomainList
        ctx={ctx}
        domains={domains.data.filter((d) => d.purpose !== "Verified Domain")}
        canEdit={canEdit}
      />
      {canEdit && purposes.length > 0 ? (
        <AddDomainForm
          org={ctx.org.slug}
          purposes={purposes.map((p) => ({
            value: p,
            label: t(`settings.domains.purposes.${p.replace(" ", "")}`),
          }))}
        />
      ) : null}
      {purposes.length === 0 ? (
        <InlineAlert tone="info">{t("settings.domains.needsPlan")}</InlineAlert>
      ) : null}
    </section>
  );
}

async function VerifiedDomainsPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const [domains, roles] = await Promise.all([
    listOrgDomains(ctx.viewer.db, ctx.org.id),
    listRoles(ctx.viewer.db, ctx.org.id),
  ]);
  if (!domains.ok || !roles.ok) return <LoadFailed message={t("settings.loadFailed")} />;
  const canEdit = ctx.capabilities.has("org.security.write");
  return (
    <section aria-labelledby="verified-heading" className="flex max-w-layout-form flex-col gap-12">
      <Heading id="verified-heading">{t("settings.domains.verifiedTitle")}</Heading>
      <p className="m-0 text-text-13 text-text-secondary">{t("settings.domains.verifiedHelp")}</p>
      <DomainList
        ctx={ctx}
        domains={domains.data.filter((d) => d.purpose === "Verified Domain")}
        canEdit={canEdit}
      />
      {canEdit ? (
        <AddDomainForm
          org={ctx.org.slug}
          purposes={[
            { value: "Verified Domain", label: t("settings.domains.purposes.VerifiedDomain") },
          ]}
          roles={roles.data
            .filter((r) => r.band >= 3)
            .map((r) => ({ value: r.id, label: r.name ?? t(`shell.roles.${r.code}`) }))}
        />
      ) : null}
    </section>
  );
}

function moduleNodes(): { module: string; label: string }[] {
  const out: { module: string; label: string }[] = [];
  const seen = new Set<string>();
  const walk = (nodes: typeof sitemap.nodes) => {
    for (const n of nodes) {
      if (n.module && n.kind === "item" && !seen.has(n.module)) {
        seen.add(n.module);
        out.push({ module: n.module, label: n.label });
      }
      if (n.children) walk(n.children);
    }
  };
  walk(sitemap.nodes);
  return out;
}

async function ModulesPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const disabled = await listDisabledModules(ctx.viewer.db, ctx.org.id);
  if (!disabled.ok) return <LoadFailed message={t("settings.loadFailed")} />;
  const off = new Set(disabled.data);
  return (
    <ModulesForm
      org={ctx.org.slug}
      canEdit={ctx.capabilities.has("org.modules.write")}
      modules={moduleNodes().map((m) => ({
        module: m.module,
        label: t(m.label),
        enabled: !off.has(m.module),
      }))}
    />
  );
}

async function LegalPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const acceptances = await listOrgLegalAcceptances(ctx.viewer.db, ctx.org.id);
  if (!acceptances.ok) return <LoadFailed message={t("settings.loadFailed")} />;
  const accepted = new Set(acceptances.data.map((a) => `${a.documentSlug}@${a.documentVersion}`));
  const pending = LEGAL_DOCUMENTS.filter(
    (d) =>
      d.acceptanceBy.includes("org_owner_at_signup") && !accepted.has(`${d.slug}@${d.version}`),
  );
  return (
    <section aria-labelledby="legal-heading" className="flex max-w-layout-form flex-col gap-12">
      {pending.length > 0 && ctx.capabilities.has("org.legal.accept") ? (
        <AcceptLegalForm
          org={ctx.org.slug}
          documents={pending.map((d) => ({ slug: d.slug, title: d.title, version: d.version }))}
        />
      ) : null}
      <Heading id="legal-heading">{t("settings.legal.title")}</Heading>
      {acceptances.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("settings.legal.none")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {acceptances.data.map((a) => (
            <li
              key={`${a.documentSlug}-${a.documentVersion}-${a.acceptedAt}`}
              className="flex flex-col gap-2 py-8"
            >
              <span className="text-label-13 font-medium">
                {LEGAL_DOCUMENTS.find((d) => d.slug === a.documentSlug)?.title ?? a.documentSlug}{" "}
                {a.documentVersion}
              </span>
              <span className="text-text-12 text-text-secondary">
                {t("settings.legal.acceptedBy", {
                  name: a.personName ?? t("settings.legal.unnamed"),
                  date: new Date(a.acceptedAt).toISOString().slice(0, 10),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The workspace values of every workspace on Settings, Workspaces, each heading linking to that workspace's own
 * settings page (A86, ADR 0006 amendment of 2026-10-21); on that page (`params.workspaceSlug`), the one workspace.
 */
export async function WorkspaceOverridesPanel({ ctx, params }: SettingsPanelProps) {
  const t = await getTranslate();
  const defs = workspaceSettings();
  const [workspaces, stored, refs] = await Promise.all([
    listWorkspaces(ctx.viewer.db, ctx.org.id),
    listSettingValues(ctx.viewer.db, ctx.org.id),
    referenceOptions(ctx, defs),
  ]);
  if (!workspaces.ok || !stored.ok) return <LoadFailed message={t("settings.loadFailed")} />;
  if (workspaces.data.length === 0) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("settings.workspaces.none")}</p>;
  }
  const one = params["workspaceSlug"];
  const shown = one === undefined ? workspaces.data : workspaces.data.filter((w) => w.slug === one);
  return (
    <>
      {shown.map((w) => (
        <section
          key={w.id}
          aria-labelledby={`ws-${w.id}`}
          className="flex max-w-layout-form flex-col"
        >
          <Heading id={`ws-${w.id}`}>
            {t("settings.workspaces.overrides", { name: w.name })}
          </Heading>
          {one === undefined ? (
            <Link
              href={`/${ctx.org.slug}/settings/workspaces/${w.slug}` as Route}
              className="text-text-13 text-accent-text underline"
            >
              {t("settingsSurfaces.workspace.open", { name: w.name })}
            </Link>
          ) : null}
          <SettingsForm
            org={ctx.org.slug}
            group="org"
            label={t("settings.workspaces.overrides", { name: w.name })}
            scopeKind="Workspace"
            scopeId={w.id}
            fields={defs.map((def) => {
              // The workspace value, else the org value, else the platform default (Section 4.5.6).
              const here = stored.data.find(
                (v) => v.key === def.key && v.scopeKind === "Workspace" && v.scopeId === w.id,
              );
              const org = stored.data.find(
                (v) => v.key === def.key && v.scopeKind === "Organization",
              );
              const orgLocked = org?.locked === true;
              const initial = here
                ? formText(here.value)
                : org
                  ? formText(org.value)
                  : def.default === null
                    ? ""
                    : formText(def.default);
              const source = here ? "Workspace" : org ? "Organization" : "Default";
              return {
                def,
                label: t(def.label),
                help: def.help ? t(def.help) : null,
                options:
                  def.type === "choice"
                    ? def.choices.map((c) => ({
                        value: c,
                        label: t(choiceLabelKey(def.key, c)),
                      }))
                    : (refs.get(def.key) ?? []),
                initial,
                sourceText: orgLocked
                  ? t("settings.source.organizationLocked")
                  : t(`settings.source.workspace${source}`),
                setHere: here !== undefined,
                locked: false,
                lockedByOrg: orgLocked,
                canEdit: ctx.capabilities.has(def.capability),
              };
            })}
          />
        </section>
      ))}
    </>
  );
}

async function TeamsPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const { data, error } = await ctx.viewer.db
    .from("teams")
    .select("id, name, description, team_members(id, deleted_at)")
    .eq("org_id", ctx.org.id)
    .is("deleted_at", null)
    .order("name");
  if (error) return <LoadFailed message={t("settings.loadFailed")} />;
  if (data.length === 0) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("settings.teams.none")}</p>;
  }
  return (
    <ul className="m-0 flex max-w-layout-form list-none flex-col divide-y divide-border-subtle p-0">
      {data.map((team) => (
        <li key={team.id} className="flex flex-col gap-2 py-8">
          {/* Each team has its own settings page (A86, ADR 0006 amendment of 2026-10-21). */}
          <Link
            href={`/${ctx.org.slug}/settings/teams/${team.id}` as Route}
            className="text-label-13 font-medium text-accent-text underline"
          >
            {team.name}
          </Link>
          <span className="text-text-12 text-text-secondary">
            {t("settings.teams.members", {
              count: team.team_members.filter((m) => m.deleted_at === null).length,
            })}
            {team.description ? ` · ${team.description}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

async function RolesPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const roles = await listRoles(ctx.viewer.db, ctx.org.id);
  if (!roles.ok) return <LoadFailed message={t("settings.loadFailed")} />;
  return (
    <ul className="m-0 flex max-w-layout-form list-none flex-col divide-y divide-border-subtle p-0">
      {roles.data.map((r) => (
        <li key={r.id} className="flex flex-col gap-2 py-8">
          <span className="text-label-13 font-medium">{r.name ?? t(`shell.roles.${r.code}`)}</span>
          <span className="text-text-12 text-text-secondary">
            {r.system
              ? t("settings.roles.system", { band: r.band })
              : t("settings.roles.custom", { band: r.band })}
          </span>
        </li>
      ))}
    </ul>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.general", order: 0, Panel: GeneralNamePanel },
  { node: "settings.white-label", order: 10, Panel: BrandPanel },
  { node: "settings.white-label", order: 20, Panel: DomainsPanel },
  { node: "settings.modules", order: 10, Panel: ModulesPanel },
  { node: "settings.security", order: 20, Panel: VerifiedDomainsPanel },
  { node: "settings.legal", order: 10, Panel: LegalPanel },
  { node: "settings.workspaces", order: 10, Panel: WorkspaceOverridesPanel },
  { node: "settings.teams", order: 10, Panel: TeamsPanel },
  { node: "settings.roles-and-capabilities", order: 10, Panel: RolesPanel },
  { node: "settings.organization-profile", order: 10, Panel: OrgProfilePanel },
  { node: "settings.members", order: 10, Panel: JoiningPanel },
  { node: "settings.members", order: 20, Panel: OffboardingPanel },
  { node: "me.profile", order: 10, Panel: ProfilePanel },
  { node: "me.profile-privacy", order: 10, Panel: PrivacyPanel },
  { node: "me.organizations", order: 10, Panel: AutoJoinPanel },
];
