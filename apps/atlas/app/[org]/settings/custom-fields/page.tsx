import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.custom-fields: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/custom-fields">) {
  return <SettingsSectionPage node="settings.custom-fields" params={await params} />;
}
