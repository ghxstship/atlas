import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.white-label: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/white-label">) {
  return <SettingsSectionPage node="settings.white-label" params={await params} />;
}
