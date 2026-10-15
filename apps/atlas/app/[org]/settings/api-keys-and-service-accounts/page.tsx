import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.api-keys-and-service-accounts: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({
  params,
}: PageProps<"/[org]/settings/api-keys-and-service-accounts">) {
  return (
    <SettingsSectionPage node="settings.api-keys-and-service-accounts" params={await params} />
  );
}
