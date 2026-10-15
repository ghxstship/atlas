import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.teams: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/teams">) {
  return <SettingsSectionPage node="settings.teams" params={await params} />;
}
