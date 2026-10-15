import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.canon-extensions: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/canon-extensions">) {
  return <SettingsSectionPage node="settings.canon-extensions" params={await params} />;
}
