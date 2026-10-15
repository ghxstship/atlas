import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.data-and-privacy: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/data-and-privacy">) {
  return <SettingsSectionPage node="settings.data-and-privacy" params={await params} />;
}
