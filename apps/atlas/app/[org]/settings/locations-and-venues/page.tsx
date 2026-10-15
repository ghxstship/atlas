import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.locations-and-venues: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/locations-and-venues">) {
  return <SettingsSectionPage node="settings.locations-and-venues" params={await params} />;
}
