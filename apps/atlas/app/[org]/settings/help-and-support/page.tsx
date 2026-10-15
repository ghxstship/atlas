import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.help-and-support: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/help-and-support">) {
  return <SettingsSectionPage node="settings.help-and-support" params={await params} />;
}
