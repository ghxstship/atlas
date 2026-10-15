import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.automations: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/automations">) {
  return <SettingsSectionPage node="settings.automations" params={await params} />;
}
