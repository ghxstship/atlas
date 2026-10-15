import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.partner: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/partner">) {
  return <SettingsSectionPage node="settings.partner" params={await params} />;
}
