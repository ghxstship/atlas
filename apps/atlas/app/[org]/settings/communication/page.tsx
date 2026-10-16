import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.communication: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/communication">) {
  return <SettingsSectionPage node="settings.communication" params={await params} />;
}
