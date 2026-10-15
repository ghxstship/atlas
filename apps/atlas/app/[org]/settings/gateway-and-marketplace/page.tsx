import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.gateway-and-marketplace: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({
  params,
}: PageProps<"/[org]/settings/gateway-and-marketplace">) {
  return <SettingsSectionPage node="settings.gateway-and-marketplace" params={await params} />;
}
