import { SettingsSectionPage } from "@/components/settings/settings-page";

/** me.notifications: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/me/notifications">) {
  return <SettingsSectionPage node="me.notifications" params={await params} />;
}
