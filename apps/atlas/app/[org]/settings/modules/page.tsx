import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.modules: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/modules">) {
  return <SettingsSectionPage node="settings.modules" params={await params} />;
}
