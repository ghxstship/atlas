import { SettingsSectionPage } from "@/components/settings/settings-page";

/** me.preferences: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/me/preferences">) {
  return <SettingsSectionPage node="me.preferences" params={await params} />;
}
