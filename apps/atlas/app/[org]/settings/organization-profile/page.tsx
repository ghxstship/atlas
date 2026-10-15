import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.organization-profile: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/organization-profile">) {
  return <SettingsSectionPage node="settings.organization-profile" params={await params} />;
}
