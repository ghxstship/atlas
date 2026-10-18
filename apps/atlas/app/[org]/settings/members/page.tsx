import { listMembers, listPendingInvites, listRoles, type Role } from "@xos/data";
import { getFormatter, getTranslations } from "next-intl/server";
import {
  InviteForm,
  MemberRoleSelect,
  RemoveMemberButton,
  RevokeInviteButton,
} from "@/components/settings/forms";
import { ContributedPanels } from "@/components/settings/contributed-panels";
import { SectionHeader } from "@/components/settings/section-header";
import { requireNode } from "@/lib/shell/require-node";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Members (Section 4.5.6, item 4): invite with a role and expiry (app.invite_member), change roles,
 * remove members (app.end_membership) and revoke pending invitations. Invitation email is A18's;
 * until it lands, the inviter shares the one-time link shown after creating the invite.
 */
export default async function MembersSettingsPage({
  params,
}: PageProps<"/[org]/settings/members">) {
  const routeParams = await params;
  const ctx = await requireNode("settings.members", routeParams);
  const db = ctx.viewer.db;
  const [members, roles, invites, t, translate, format] = await Promise.all([
    listMembers(db, ctx.org.id),
    listRoles(db, ctx.org.id),
    listPendingInvites(db, ctx.org.id),
    getTranslations("shell.settings.members"),
    getTranslate(),
    getFormatter(),
  ]);
  for (const result of [members, roles, invites]) {
    if (!result.ok) throw new Error(`Cannot load members: ${JSON.stringify(result.error)}`);
  }
  const roleLabel = (r: Role) => r.name ?? translate(`shell.roles.${r.code}`);
  const myBand = ctx.org.bestBand ?? 8;
  const allRoles = roles.ok ? roles.data : [];
  const assignable = allRoles
    .filter((r) => r.band >= myBand)
    .map((r) => ({ id: r.id, label: roleLabel(r) }));
  const viewer = allRoles.find((r) => r.system && r.code === "viewer");
  const canManage = ctx.capabilities.has("org.members.manage");
  const canInvite = ctx.capabilities.has("org.members.invite");

  return (
    <>
      <SectionHeader node="settings.members" />
      {canInvite ? (
        <InviteForm
          org={ctx.org.slug}
          roles={assignable}
          defaultRoleId={viewer?.id ?? assignable.at(-1)?.id ?? ""}
        />
      ) : null}
      <section aria-labelledby="members-heading" className="flex flex-col gap-8">
        <h2 id="members-heading" className="m-0 text-heading-16 font-semibold">
          {t("list")}
        </h2>
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {(members.ok ? members.data : []).map((m) => {
            const name = m.fullName ?? t("unnamed");
            const self = m.membershipId === ctx.org.membershipId;
            const role = m.roles[0];
            return (
              <li
                key={m.membershipId}
                className="flex flex-wrap items-end justify-between gap-12 py-12"
              >
                <div className="flex flex-col gap-2">
                  <span className="text-label-13 font-medium">
                    {name}
                    {self ? ` · ${t("you")}` : ""}
                  </span>
                  <span className="text-text-12 text-text-secondary">
                    {t("since", {
                      date: format.dateTime(new Date(m.validFrom), { dateStyle: "medium" }),
                    })}
                  </span>
                </div>
                <div className="flex items-end gap-8">
                  {role ? (
                    <MemberRoleSelect
                      org={ctx.org.slug}
                      membershipId={m.membershipId}
                      roleId={role.id}
                      name={name}
                      roles={
                        assignable.some((r) => r.id === role.id)
                          ? assignable
                          : [{ id: role.id, label: roleLabel(role) }, ...assignable]
                      }
                      disabled={!canManage || self || role.band < myBand}
                    />
                  ) : null}
                  {canManage && !self && (role?.band ?? 8) >= myBand ? (
                    <RemoveMemberButton
                      org={ctx.org.slug}
                      orgName={ctx.org.name}
                      membershipId={m.membershipId}
                      name={name}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-labelledby="pending-heading" className="flex flex-col gap-8">
        <h2 id="pending-heading" className="m-0 text-heading-16 font-semibold">
          {t("pending")}
        </h2>
        {invites.ok && invites.data.length > 0 ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {invites.data.map((invite) => {
              const role = allRoles.find((r) => r.id === invite.roleId);
              return (
                <li key={invite.id} className="flex items-center justify-between gap-12 py-12">
                  <div className="flex flex-col gap-2">
                    <span className="text-label-13 font-medium">{invite.email}</span>
                    <span className="text-text-12 text-text-secondary">
                      {role ? `${roleLabel(role)} · ` : ""}
                      {t("expiresOn", {
                        date: format.dateTime(new Date(invite.expiresAt), { dateStyle: "medium" }),
                      })}
                    </span>
                  </div>
                  {canInvite ? (
                    <RevokeInviteButton org={ctx.org.slug} inviteId={invite.id} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="m-0 text-text-13 text-text-secondary">{t("noPending")}</p>
        )}
      </section>
      <ContributedPanels node="settings.members" ctx={ctx} params={routeParams} />
    </>
  );
}
