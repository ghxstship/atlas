import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.workspaces: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/workspaces">) {
  return <SettingsSectionPage node="settings.workspaces" params={await params} />;
}
