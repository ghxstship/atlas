import { SettingsSectionPage } from "@/components/settings/settings-page";

/** me.connected-apps: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/me/connected-apps">) {
  return <SettingsSectionPage node="me.connected-apps" params={await params} />;
}
