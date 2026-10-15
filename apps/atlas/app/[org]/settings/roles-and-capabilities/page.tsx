import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.roles-and-capabilities: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({
  params,
}: PageProps<"/[org]/settings/roles-and-capabilities">) {
  return <SettingsSectionPage node="settings.roles-and-capabilities" params={await params} />;
}
