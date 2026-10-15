import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.danger-zone: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/danger-zone">) {
  return <SettingsSectionPage node="settings.danger-zone" params={await params} />;
}
