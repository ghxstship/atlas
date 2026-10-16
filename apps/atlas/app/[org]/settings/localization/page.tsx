import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.localization: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/localization">) {
  return <SettingsSectionPage node="settings.localization" params={await params} />;
}
