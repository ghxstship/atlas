import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.views-and-defaults: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/views-and-defaults">) {
  return <SettingsSectionPage node="settings.views-and-defaults" params={await params} />;
}
