import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.departments-and-disciplines: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({
  params,
}: PageProps<"/[org]/settings/departments-and-disciplines">) {
  return <SettingsSectionPage node="settings.departments-and-disciplines" params={await params} />;
}
