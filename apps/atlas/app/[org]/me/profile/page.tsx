import { SettingsSectionPage } from "@/components/settings/settings-page";

/** me.profile: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/me/profile">) {
  return <SettingsSectionPage node="me.profile" params={await params} />;
}
