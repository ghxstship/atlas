import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.webhooks: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/webhooks">) {
  return <SettingsSectionPage node="settings.webhooks" params={await params} />;
}
