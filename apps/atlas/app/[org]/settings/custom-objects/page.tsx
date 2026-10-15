import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.custom-objects: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/custom-objects">) {
  return <SettingsSectionPage node="settings.custom-objects" params={await params} />;
}
