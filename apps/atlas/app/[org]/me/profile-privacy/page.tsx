import { SettingsSectionPage } from "@/components/settings/settings-page";

/** me.profile-privacy: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/me/profile-privacy">) {
  return <SettingsSectionPage node="me.profile-privacy" params={await params} />;
}
