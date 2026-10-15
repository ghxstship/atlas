import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.general: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/general">) {
  return <SettingsSectionPage node="settings.general" params={await params} />;
}
