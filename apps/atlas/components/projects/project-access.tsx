import {
  listProjectMemberRoles,
  listProjectShares,
  listSharePartners,
  type ProjectRole,
} from "@xos/data/access-controls";
import type { ProjectMember } from "@xos/data/projects";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import {
  AddProjectRoleForm,
  RemoveProjectRoleButton,
  RevokeShareButton,
  ShareProjectForm,
} from "@/components/settings/access-control-forms";
import { InlineAlert } from "@/components/ui";
import type { ProjectContext } from "@/lib/projects/context";
import { enumKey } from "@/lib/projects/format";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Project Settings additions from A52 (RRR-97): the extra project roles members hold on this
 * project (Section 4.8.1, migration 1204) and the partner orgs it is shared with (Section 8.5,
 * migration 1205). Reads run with the viewer's client; the forms post to
 * access-control-actions.ts, and the database refuses anything the viewer may not do.
 */

const P = "settings.accessControls";

function Section({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-12 border-t border-border-subtle pt-20"
    >
      <div className="flex flex-col gap-4">
        <h2 id={id} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">{lead}</p>
      </div>
      {children}
    </section>
  );
}

export async function ProjectAccess({
  ctx,
  members,
  roles,
}: {
  ctx: ProjectContext;
  members: readonly ProjectMember[];
  roles: readonly ProjectRole[];
}) {
  const t = await getTranslate();
  const tp = await getTranslations("projects");
  const db = ctx.org.viewer.db;
  const canMembers = ctx.capabilities.has("projects.members.manage");
  const canShare = ctx.org.capabilities.has("org.access_grants.manage");
  const [held, shares, partners] = await Promise.all([
    listProjectMemberRoles(db, ctx.project.id),
    listProjectShares(db, ctx.project.id),
    canShare
      ? listSharePartners(db, ctx.org.org.id)
      : Promise.resolve({ ok: true as const, data: [] }),
  ]);
  if (!held.ok || !shares.ok || !partners.ok) {
    return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  }
  const roleLabel = (r: ProjectRole) => tp(`roles.${enumKey(r)}` as "roles.field");
  const roleOptions = roles.map((r) => ({ value: r, label: roleLabel(r) }));
  const byMember = new Map(members.map((m) => [m.id, m]));
  const extra = held.data.filter((r) => {
    const m = byMember.get(r.projectMemberId);
    return m !== undefined && m.role !== r.role;
  });
  const me = ctx.org.viewer.person?.id;
  const partnerName = new Map(partners.data.map((p) => [p.organizationId, p.name]));
  const sharedWith = new Set(shares.data.map((s) => s.partnerOrganizationId));
  const partnerOptions = partners.data
    .filter((p) => !sharedWith.has(p.organizationId))
    .map((p) => ({ value: p.organizationId, label: p.name ?? t(`${P}.shares.unnamedPartner`) }));

  return (
    <>
      <Section
        id="settings-project-roles"
        title={t(`${P}.projectRoles.title`)}
        lead={t(`${P}.projectRoles.lead`)}
      >
        {extra.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.projectRoles.none`)}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {extra.map((r) => {
              const m = byMember.get(r.projectMemberId);
              const name = m?.fullName ?? tp("settings.unnamed");
              const label = t(`${P}.projectRoles.entry`, { name, role: roleLabel(r.role) });
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                  <span className="flex flex-col">
                    <span className="text-text-14 text-text-primary">{name}</span>
                    <span className="text-text-12 text-text-secondary">
                      {t(`${P}.projectRoles.alsoHolds`, {
                        lead: roleLabel(m?.role ?? r.role),
                        role: roleLabel(r.role),
                      })}
                    </span>
                  </span>
                  {canMembers ? (
                    <RemoveProjectRoleButton
                      org={ctx.org.org.slug}
                      projectKey={ctx.project.key}
                      id={r.id}
                      label={label}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {canMembers && members.some((m) => m.personId !== me) ? (
          <AddProjectRoleForm
            org={ctx.org.org.slug}
            projectKey={ctx.project.key}
            members={members
              .filter((m) => m.personId !== me)
              .map((m) => ({ value: m.id, label: m.fullName ?? tp("settings.unnamed") }))}
            roles={roleOptions}
          />
        ) : null}
      </Section>

      <Section
        id="settings-project-shares"
        title={t(`${P}.shares.title`)}
        lead={t(`${P}.shares.lead`)}
      >
        {shares.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.shares.none`)}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {shares.data.map((s) => {
              const name =
                partnerName.get(s.partnerOrganizationId) ?? t(`${P}.shares.unnamedPartner`);
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                  <span className="flex flex-col">
                    <span className="text-text-14 text-text-primary">{name}</span>
                    <span className="text-text-12 text-text-secondary">
                      {t(`${P}.shares.asRole`, { role: roleLabel(s.projectRole) })}
                    </span>
                  </span>
                  {canShare ? (
                    <RevokeShareButton
                      org={ctx.org.org.slug}
                      projectKey={ctx.project.key}
                      id={s.id}
                      name={name}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {canShare ? (
          partnerOptions.length > 0 ? (
            <ShareProjectForm
              org={ctx.org.org.slug}
              projectKey={ctx.project.key}
              partners={partnerOptions}
              roles={roleOptions}
            />
          ) : (
            <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.shares.noPartners`)}</p>
          )
        ) : null}
      </Section>
    </>
  );
}
