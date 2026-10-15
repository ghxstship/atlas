import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.separation-of-duties: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/separation-of-duties">) {
  return <SettingsSectionPage node="settings.separation-of-duties" params={await params} />;
}
