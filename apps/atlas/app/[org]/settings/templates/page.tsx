import { SettingsSectionPage } from "@/components/settings/settings-page";

/** settings.templates: registered settings and contributed panels (Section 4.5.6). */
export default async function Page({ params }: PageProps<"/[org]/settings/templates">) {
  return <SettingsSectionPage node="settings.templates" params={await params} />;
}
