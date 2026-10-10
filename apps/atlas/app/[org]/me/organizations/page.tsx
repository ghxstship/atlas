import { getTranslations } from "next-intl/server";
import { LeaveOrganizationButton } from "@/components/settings/leave-org";
import { SectionHeader } from "@/components/settings/section-header";
import { requireNode } from "@/components/shell/sitemap-page";
import { getMyOrganizations } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Personal settings, Organizations (Section 4.5.6, personal item 5): every membership, with leave.
 * Engagements and the default org arrive with A28 and A30.
 */
export default async function MyOrganizationsPage({
  params,
}: PageProps<"/[org]/me/organizations">) {
  const ctx = await requireNode("me.organizations", await params);
  const [orgs, t, translate] = await Promise.all([
    getMyOrganizations(),
    getTranslations("shell.settings.organizations"),
    getTranslate(),
  ]);
  return (
    <>
      <SectionHeader node="me.organizations" />
      <ul className="m-0 flex max-w-layout-form list-none flex-col divide-y divide-border-subtle p-0">
        {orgs.map((org) => {
          const role = org.roles[0];
          return (
            <li key={org.id} className="flex items-center justify-between gap-12 py-12">
              <div className="flex flex-col gap-2">
                <span className="text-label-13 font-medium">{org.name}</span>
                <span className="text-text-12 text-text-secondary">
                  {role ? (role.name ?? translate(`shell.roles.${role.code}`)) : ""}
                  {org.id === ctx.org.id ? ` · ${t("current")}` : ""}
                </span>
              </div>
              <LeaveOrganizationButton orgId={org.id} orgName={org.name} />
            </li>
          );
        })}
      </ul>
    </>
  );
}
