import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.legal-entities-and-fiscal: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({
  params,
}: PageProps<"/[org]/settings/legal-entities-and-fiscal">) {
  return <SettingsSectionPage node="settings.legal-entities-and-fiscal" params={await params} />;
}
