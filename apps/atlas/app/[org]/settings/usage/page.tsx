import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.usage: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/usage">) {
  return <SettingsSectionPage node="settings.usage" params={await params} />;
}
